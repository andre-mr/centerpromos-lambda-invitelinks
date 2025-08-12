import https from "node:https";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";

let _docClient = null;
let _clientConfigKey = null;

/** Creates the DocumentClient with keep-alive (recreates if config changes, only once). */
function getDocClient(event = {}) {
  const creds = event.credentials || {};
  const region = creds.AMAZON_REGION || process.env.AMAZON_REGION || "sa-east-1";
  const accessKeyId = creds.AMAZON_ACCESS_KEY_ID || process.env.AMAZON_ACCESS_KEY_ID;
  const secretAccessKey = creds.AMAZON_SECRET_ACCESS_KEY || process.env.AMAZON_SECRET_ACCESS_KEY;

  const configKey = `${region}|${accessKeyId ? "withCreds" : "noCreds"}`;
  if (_docClient && _clientConfigKey === configKey) return _docClient;

  console.time("[database] initializeClient");

  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 64,
    maxFreeSockets: 16,
    timeout: 30_000,
  });

  const clientConfig = {
    region,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      httpsAgent,
      connectionTimeout: 200,
      socketTimeout: 1_500,
    }),
  };

  if (accessKeyId && secretAccessKey) {
    clientConfig.credentials = { accessKeyId, secretAccessKey };
  }

  const client = new DynamoDBClient(clientConfig);

  _docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  _clientConfigKey = configKey;

  console.timeEnd("[database] initializeClient");
  return _docClient;
}

/** Extracts campaign/category from the path. */
function parsePath(event = {}) {
  let rawPath = null;

  // API Gateway HTTP API (v2) with/without wrapper
  if (event.rawEvent?.rawPath) rawPath = event.rawEvent.rawPath;
  else if (event.rawEvent?.requestContext?.http?.path) rawPath = event.rawEvent.requestContext.http.path;
  else if (event.rawPath) rawPath = event.rawPath;
  else if (event.requestContext?.http?.path) rawPath = event.requestContext.http.path;

  if (!rawPath || rawPath === "/") return null;

  const [campaignRaw, categoryRaw] = rawPath.replace(/^\//, "").split("/");
  const campaign = campaignRaw?.toUpperCase();
  const category = categoryRaw?.toUpperCase();
  if (!campaign) return null;

  const sortKey = category ? `${campaign}#${category}` : campaign;
  return { campaign, category, sortKey };
}

//Fetches the invite from DynamoDB, selects the code, and triggers UPDATE (fire-and-forget).
export async function getInviteCode(event = {}) {
  console.time("[database] getInviteCode total");

  const tableName = event.credentials?.AMAZON_DYNAMODB_TABLE || process.env.AMAZON_DYNAMODB_TABLE || null;

  if (!tableName) {
    throw new Error("AMAZON_DYNAMODB_TABLE não definida nas variáveis de ambiente.");
  }

  const parsed = parsePath(event);

  if (!parsed) {
    console.timeEnd("[database] getInviteCode total");
    return null;
  }

  const { sortKey } = parsed;
  const doc = getDocClient(event);

  try {
    console.time("[database] dynamodb:GetCommand");
    const result = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: "WHATSAPP#INVITELINKS", SK: sortKey },
      })
    );
    console.timeEnd("[database] dynamodb:GetCommand");

    const list = result.Item?.InviteCodes;
    if (!Array.isArray(list) || list.length === 0) {
      console.timeEnd("[database] getInviteCode total");
      return null;
    }

    console.time("[database] selectInviteCode");
    const updatedTime = result.Item.Updated ? new Date(result.Item.Updated) : null;
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    let invite = list[0];
    if (updatedTime && updatedTime < twoHoursAgo) {
      invite = list[Math.floor(Math.random() * list.length)];
    }

    const parts = String(invite).split("|");
    const inviteCode = parts.length >= 3 ? parts[2] : null;
    console.timeEnd("[database] selectInviteCode");

    if (!inviteCode) {
      console.timeEnd("[database] getInviteCode total");
      return null;
    }

    // ---- ASYNCHRONOUS INCREMENT (fire-and-forget) ----
    (async () => {
      const label = `[database] incrementClicks:${sortKey}`;
      if (!isTestEnv()) console.time(label);
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: "WHATSAPP#INVITELINKS", SK: sortKey },
            UpdateExpression: "SET Clicks = if_not_exists(Clicks, :zero) + :inc",
            ExpressionAttributeValues: { ":inc": 1, ":zero": 0 },
          })
        );
      } catch (err) {
        console.error(`Error incrementing Clicks for ${sortKey}:`, err);
      } finally {
        if (!isTestEnv()) console.timeEnd(label);
      }
    })().catch((e) => console.error("increment fire-and-forget error:", e));
    // --------------------------------------------------

    console.timeEnd("[database] getInviteCode total");
    return { inviteCode, sortKey };
  } catch (error) {
    console.error(`Error getting invite link for ${sortKey}:`, error);
    console.timeEnd("[database] getInviteCode total");
    throw error;
  }
}

// Utility to detect test environment
function isTestEnv() {
  return process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === "test";
}
