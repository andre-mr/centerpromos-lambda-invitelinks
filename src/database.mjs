import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

let docClient = null;
let AMAZON_DYNAMODB_TABLE = null;

export const initializeClient = (event = {}) => {
  const { AMAZON_ACCESS_KEY_ID, AMAZON_SECRET_ACCESS_KEY, AMAZON_DYNAMODB_TABLE: eventTable } = event.credentials || {};

  AMAZON_DYNAMODB_TABLE = eventTable || process.env.AMAZON_DYNAMODB_TABLE;

  const ddbClientOptions = {};

  if (process.env.AMAZON_REGION) {
    ddbClientOptions.region = process.env.AMAZON_REGION;
  }
  if (AMAZON_ACCESS_KEY_ID && AMAZON_SECRET_ACCESS_KEY) {
    ddbClientOptions.credentials = {
      accessKeyId: AMAZON_ACCESS_KEY_ID,
      secretAccessKey: AMAZON_SECRET_ACCESS_KEY,
    };
  }

  const ddbClient = new DynamoDBClient(ddbClientOptions);
  docClient = DynamoDBDocumentClient.from(ddbClient);
};

const incrementClicks = async (sortKey) => {
  const params = {
    TableName: AMAZON_DYNAMODB_TABLE,
    Key: { PK: "WHATSAPP#INVITELINKS", SK: sortKey },
    UpdateExpression: "SET Clicks = if_not_exists(Clicks, :zero) + :inc",
    ExpressionAttributeValues: {
      ":inc": 1,
      ":zero": 0,
    },
  };
  try {
    await docClient.send(new UpdateCommand(params));
  } catch (error) {
    console.error(`Error incrementing Clicks for sortKey ${sortKey}:`, error);
  }
};

export const getInviteCode = async (event = {}) => {
  initializeClient(event);

  let path = null;
  if (event.rawEvent?.rawPath) {
    path = event.rawEvent.rawPath;
  } else if (event.rawEvent?.requestContext?.http?.path) {
    path = event.rawEvent.requestContext.http.path;
  } else if (event.rawPath) {
    path = event.rawPath;
  } else if (event.requestContext?.http?.path) {
    path = event.requestContext.http.path;
  }

  if (!path || path === "/") {
    return null;
  }

  const fragments = path.replace(/^\//, "").split("/");
  const campaign = fragments[0]?.toUpperCase();
  const category = fragments[1]?.toUpperCase();

  if (!campaign) {
    return null;
  }

  const sortKey = category ? `${campaign}#${category}` : campaign;

  const params = {
    TableName: AMAZON_DYNAMODB_TABLE,
    Key: {
      PK: "WHATSAPP#INVITELINKS",
      SK: sortKey,
    },
  };

  try {
    const result = await docClient.send(new GetCommand(params));

    if (result.Item?.InviteCodes?.length) {
      const updatedTime = result.Item.Updated ? new Date(result.Item.Updated) : null;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      let inviteCode;
      if (updatedTime && updatedTime < twoHoursAgo) {
        const randomIndex = Math.floor(Math.random() * result.Item.InviteCodes.length);
        inviteCode = result.Item.InviteCodes[randomIndex];
      } else {
        inviteCode = result.Item.InviteCodes[0];
      }

      const parts = inviteCode.split("|");

      incrementClicks(sortKey);
      return parts.length >= 3 ? parts[2] : null;
    }

    return null;
  } catch (error) {
    console.error(`Error getting invite link for campaign ${campaign}${category ? "#" + category : ""}`);
    throw error;
  }
};
