/**
 *env variables:
 *   TABLE_NAME - DynamoDB table name
 *
 * 
 * This is the main Lambda handler for the vanity number generator. It is designed to be invoked by an AWS Connect contact flow.
 * Talks to DynamoDB to check for existing results, and if none exist, generates new vanities and stores them. 
 * The top 3 vanities are then returned to Connect for use in the contact flow.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { generateVanities } from "./vanity-generator.mjs";

//get table name
// eslint-disable-next-line no-undef
const TABLE_NAME = process.env.TABLE_NAME;

//constant GSI partition value: every record shares it so the dashboard can Query
//the LastCalledIndex (sorted by LastCalled) instead of scanning the whole table.
const GSI_PARTITION_ATTR = "GSIPartition";
const GSI_PARTITION_VALUE = "ALL";

//dynamo client instance
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  //table null check
  if (!TABLE_NAME) {
    console.error("TABLE_NAME env variable is not set.");
    return errorResponse("Table is null.");
  }

  //get raw number from event - fatal fail
  let rawNumber;
  try {
    rawNumber = event?.Details?.ContactData?.CustomerEndpoint?.Address;
    if (!rawNumber) {
      throw new Error("CustomerEndpoint.Address is missing from call event.");
    }
  } catch (err) {
    console.error("Failed to extract caller number:", err.message);
    return errorResponse("Unable to identify phone number.");
  }
  console.log("Processing number:", rawNumber);

  //check if number already exists in db and return stored results if so - non fatal fail
  try {
    const existing = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { CallerId: rawNumber },
      })
    );

    if (existing.Item) {
      console.log(`Existing record found for ${rawNumber} — returning stored results.`);

      let stored = existing.Item.VanityResults ?? [];

      //legacy records may have been stored before the tts field existed (or with no
      //results at all). Regenerate so the speech block isn't empty, and heal the
      //record so subsequent calls are served correctly from cache.
      const needsBackfill =
        stored.length === 0 ||
        stored.some((v) => v && typeof v === "object" && !v.tts);

      if (needsBackfill) {
        console.log("Stored record is missing tts — regenerating and healing.");
        try {
          stored = await generateVanities(rawNumber);
          await docClient.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: {
                CallerId: rawNumber,
                LastCalled: new Date().toISOString(),
                VanityResults: stored,
                [GSI_PARTITION_ATTR]: GSI_PARTITION_VALUE,
              },
            })
          );
        } catch (err) {
          console.error("Failed to backfill cached record:", err.message);
        }
      } else {
        //fresh enough — refresh the timestamp of this call log. Also (re)set the GSI
        //partition so the record is present in LastCalledIndex even if it predates it.
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: TABLE_NAME,
              Key: { CallerId: rawNumber },
              UpdateExpression: `SET LastCalled = :now, ${GSI_PARTITION_ATTR} = :gsi`,
              ExpressionAttributeValues: {
                ":now": new Date().toISOString(),
                ":gsi": GSI_PARTITION_VALUE,
              },
            })
          );
        } catch (err) {
          console.error("Timestamp refresh failed:", err.message);
        }
      }

      //record existed, so this is a repeat caller -> "welcome back" greeting.
      return buildConnectResponse(stored, { returning: true });
    }
  } catch (err) {
    //get failed - log but continue to generate new results
    console.error("GetItem failed — proceeding with generation:", err.message);
  }

  //save current timestamp for logging the call
  const calledAt = new Date().toISOString();

  //generate vanities for the local number (7 digits).
  //generation is non-fatal here: we still log that the caller called and when.
  let parsed = [];
  let generationFailed = false;
  try {
    parsed = await generateVanities(rawNumber);
  }
  catch (err) {
    console.error("Vanity generation error:", err.message);
    generationFailed = true;
  }

  //construct a new db item
  const item = {
    CallerId: rawNumber,
    LastCalled: calledAt,
    VanityResults: parsed,
    [GSI_PARTITION_ATTR]: GSI_PARTITION_VALUE, // groups records into the LastCalledIndex GSI
  };

  //attempt to write to db - non fatal fail
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: "attribute_not_exists(CallerId)",
      })
    );
    console.log("DynamoDB write successful.");
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.warn("Concurrent write for same CallerId. Ignoring.");
    } else {
      console.error("DynamoDB write failed:", err.message, err.name);
    }
  }

  //the call is logged above; now surface a generation failure to Connect.
  if (generationFailed) {
    return errorResponse("Vanity generation failed.");
  }

  //no prior record -> first-time caller -> "your new vanity numbers" greeting.
  const response = buildConnectResponse(parsed, { returning: false });
  //log results
  console.log("Returning to Connect:", JSON.stringify(response));
  return response;
};

//spoken greeting played before the vanity numbers. The contact flow can read it as
//$.External.greeting, or branch on $.External.isReturning ("true" / "false").
const GREETING_RETURNING = "Welcome back! Your vanity numbers are:";
const GREETING_NEW = "Your new vanity numbers are:";

//builds the Amazon Connect response from a list of vanity candidates: the top 3
//formatted strings (for display) and their tts strings (for the speech block).
//missing slots are padded with empty strings so the contact flow always has the keys.
//`returning` selects the greeting: true for a repeat caller (served from cache),
//false for a first-time caller.
function buildConnectResponse(candidates, { returning = false } = {}) {
  const top3 = (candidates ?? []).slice(0, 3);
  while (top3.length < 3) top3.push({});
  return {
    status: "success",
    //ready-to-speak greeting + a flag so the flow can branch instead, if preferred
    greeting: returning ? GREETING_RETURNING : GREETING_NEW,
    isReturning: returning ? "true" : "false",
    vanity1: top3[0]?.formatted ?? "",
    vanity2: top3[1]?.formatted ?? "",
    vanity3: top3[2]?.formatted ?? "",
    vanity1tts: top3[0]?.tts ?? "",
    vanity2tts: top3[1]?.tts ?? "",
    vanity3tts: top3[2]?.tts ?? "",
  };
}

//helper for building an error response to return to Connect. 
//the contact flow should check for status === "error" and branch accordingly.
function errorResponse(reason) {
  console.error("Returning error response:", reason);
  return {
    status: "error",
    vanityResults: [],
    errorReason: reason,
  };
}
