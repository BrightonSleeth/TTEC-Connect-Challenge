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
 */

//get table name
// eslint-disable-next-line no-undef
const TABLE_NAME = process.env.TABLE_NAME;

import { generateVanities } from "./vanity-generator.mjs";

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

  let parsed;
  try {
    //generate vanities for the local number (7 digits)
    parsed = await generateVanities(rawNumber);
    //sort by score and return top 5
    parsed = Array.from(parsed).sort((a, b) => b.score - a.score).slice(0, 5);
  }
  catch (err) {
    console.error("Vanity generation error:", err.message);
    return errorResponse("Vanity generation failed.");
  }

  //create test example response
  const response = {
    status: "success",
    vanityResults: parsed,
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
