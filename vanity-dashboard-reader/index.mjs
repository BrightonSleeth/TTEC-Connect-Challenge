import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

//dynamo client instance
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

//get env vars
// eslint-disable-next-line no-undef
const TABLE   = process.env.VANITY_TABLE;
// eslint-disable-next-line no-undef
const ORIGIN  = process.env.ALLOWED_ORIGIN ?? "*";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

//Flattens the stored VanityResults into parallel arrays for the dashboard:
//a display string per result and a matching score. Tolerates the legacy shape
//(plain display strings) and any missing fields so a bad record can't break the scan.
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
    //scan db for data on table
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    //store items from result or a new array
    const items = result.Items ?? [];

    //sort decending by call time, filter out seen, limit size to 5, and finally map data.
    //the generator stores the call time as LastCalled; CreatedAt/Timestamp are
    //fallbacks for any older records written before that field existed.
    const callTime = (item) => item.LastCalled ?? item.CreatedAt ?? item.Timestamp ?? "";
    const seen = new Set();
    const recent = items
      .sort((a, b) => callTime(b).localeCompare(callTime(a)))
      .filter((item) => {
        if (seen.has(item.CallerId)) return false;
        seen.add(item.CallerId);
        return true;
      })
      .slice(0, 5)
      .map((item) => {
        //VanityResults is now an array of candidate objects
        //({ vanityNum, formatted, word, score }) written by the generator lambda.
        //Flatten it into the parallel display/score arrays the dashboard consumes.
        const { vanityResults, topScores } = projectVanities(item.VanityResults);
        return {
          callerId:      item.CallerId,
          timestamp:     callTime(item),
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
    console.error("DynamoDB scan failed:", err.message);
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Failed to fetch callers from database." }),
    };
  }
};
