import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

//dynamo client instance
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

//get env vars
// eslint-disable-next-line no-undef
const TABLE   = process.env.VANITY_TABLE;
// eslint-disable-next-line no-undef
const ORIGIN  = process.env.ALLOWED_ORIGIN ?? "*";

//GSI written by the generator: every record carries GSIPartition="ALL" and is sorted
//by LastCalled, so we can Query the most-recent callers instead of scanning the table.
const INDEX_NAME = "LastCalledIndex";
const GSI_PARTITION_ATTR = "GSIPartition";
const GSI_PARTITION_VALUE = "ALL";
const MAX_CALLERS = 5;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

//Flattens the stored VanityResults into parallel arrays for the dashboard:
//a display string per result and a matching score. Tolerates the legacy shape
//(plain display strings) and any missing fields so a bad record can't break the query.
function projectVanities(results) {
  const vanityResults = [];
  const topScores = [];

  for (const r of Array.isArray(results) ? results : []) {
    if (typeof r === "string") {
      //legacy records stored display strings directly
      vanityResults.push(r);
      topScores.push(null);
      continue;
    }
    if (r && typeof r === "object") {
      vanityResults.push(r.formatted ?? r.vanityNum ?? "");
      topScores.push(typeof r.score === "number" ? r.score : null);
    }
  }

  return { vanityResults, topScores };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  //return 500 if null table
  if (!TABLE) {
    console.error("VANITY_TABLE env var not set");
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Table is null." }),
    };
  }

  try {
    //Query the GSI for the most-recent callers (newest first). Because CallerId is the
    //table's sole key there is one record per caller, so no de-duplication is needed —
    //the index already gives unique callers ordered by LastCalled.
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: INDEX_NAME,
        KeyConditionExpression: "#p = :all",
        ExpressionAttributeNames: { "#p": GSI_PARTITION_ATTR },
        ExpressionAttributeValues: { ":all": GSI_PARTITION_VALUE },
        ScanIndexForward: false, // descending by LastCalled (most recent first)
        Limit: MAX_CALLERS,
      })
    );
    const items = result.Items ?? [];

    //LastCalled is the GSI sort key, so it's always present; CreatedAt/Timestamp remain
    //as fallbacks for any older records.
    const callTime = (item) => item.LastCalled ?? item.CreatedAt ?? item.Timestamp ?? "";
    const recent = items.map((item) => {
      //VanityResults is an array of candidate objects ({ vanityNum, formatted, word, score });
      //flatten it into the parallel display/score arrays the dashboard consumes.
      const { vanityResults, topScores } = projectVanities(item.VanityResults);
      return {
        callerId:  item.CallerId,
        timestamp: callTime(item),
        vanityResults,
        topScores,
      };
    });
    //return success
    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":  "application/json",
        "Cache-Control": "max-age=25",
      },
      body: JSON.stringify({ callers: recent }),
    };
  } catch (err) {
    console.error("DynamoDB query failed:", err.message);
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Failed to fetch callers from database." }),
    };
  }
};
