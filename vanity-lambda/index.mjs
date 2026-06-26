/**
 *env variables:
 *   TABLE_NAME - DynamoDB table name
 *
 *expected item shape:
 *  {
 *    CallerId:      "+19015551234",
 *    CreatedAt:     "2024-01-15T10:30:00Z",
 *    VanityResults: ["1-800-FLOWERS", ...],
 *    TopScores:     [100, 87, 75, 60, 45],
 *    TopWords:      [["flowers"], ["flow"]],
 *    LocalNumber:   "5551234"
 *  }
 * 
 * This is the main Lambda handler for the vanity number generator. It is designed to be invoked by an AWS Connect contact flow.
 * Talks to DynamoDB to check for existing results, and if none exist, generates new vanities and stores them. 
 * The top 3 vanities are then returned to Connect for use in the contact flow.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { generateVanities } from "./vanity-generator.mjs";

//get table name
// eslint-disable-next-line no-undef
const TABLE_NAME = process.env.TABLE_NAME;

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
      const stored = existing.Item.VanityResults ?? [];
      const top3 = stored.slice(0, 3);
      while (top3.length < 3) top3.push("");
      return {
        status: "success",
        vanity1: top3[0]?.formatted ?? "",
        vanity2: top3[1]?.formatted ?? "",
        vanity3: top3[2]?.formatted ?? "",
      };
    }
  } catch (err) {
    //get failed - log but continue to generate new results
    console.error("GetItem failed — proceeding with generation:", err.message);
  }

  //generate vanities for the local number (7 digits) - fatal fail
  let parsed;
  try {
    parsed = await generateVanities(rawNumber);
  }
  catch (err) {
    console.error("Vanity generation error:", err.message);
    return errorResponse("Vanity generation failed.");
  }

    //construct a new db item with new values
    const item = {
      CallerId: rawNumber,
      CreatedAt: new Date().toISOString(),
      VanityResults: parsed
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

  //create response
  const response = {
    status: "success",
    vanity1: parsed[0]?.formatted ?? "",
    vanity2: parsed[1]?.formatted ?? "",
    vanity3: parsed[2]?.formatted ?? "",
  };
  //log results
  console.log("Returning to Connect:", JSON.stringify(response));
  return response;
};

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
