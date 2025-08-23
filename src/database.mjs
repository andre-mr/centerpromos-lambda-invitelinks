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

  // Allows tuning without redeploy
  const envConnTimeout = Number(process.env.DDB_CONN_TIMEOUT_MS) || 800;
  const envSocketTimeout = Number(process.env.DDB_SOCKET_TIMEOUT_MS) || 1200;
  const envMaxAttempts = Number(process.env.DDB_MAX_ATTEMPTS) || 2;
  const envMaxSockets = Number(process.env.DDB_MAX_SOCKETS) || 16;

  const configKey = `${region}|${
    accessKeyId ? "withCreds" : "noCreds"
  }|${envConnTimeout}|${envSocketTimeout}|${envMaxAttempts}|${envMaxSockets}`;
  if (_docClient && _clientConfigKey === configKey) return _docClient;

  console.time("[database] initializeClient");

  const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60_000, // keep TCP/TLS alive during short periods of inactivity
    maxSockets: envMaxSockets,
    maxFreeSockets: Math.min(8, envMaxSockets),
    timeout: 0, // don't use global agent timeout; rely on socketTimeout in handler
  });

  const clientConfig = {
    region,
    maxAttempts: envMaxAttempts,
    requestHandler: new NodeHttpHandler({
      httpsAgent,
      connectionTimeout: envConnTimeout,
      socketTimeout: envSocketTimeout,
    }),
  };

  if (accessKeyId && secretAccessKey) {
    clientConfig.credentials = { accessKeyId, secretAccessKey };
  }

  const client = new DynamoDBClient(clientConfig);

  _docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  // Simple middleware to log actual attempts (helps validate tuning)
  _docClient.middlewareStack.add(
    (next, context) => async (args) => {
      const t0 = Date.now();
      try {
        const out = await next(args);
        if (out?.$metadata) {
          console.log(
            `[database] ${context.commandName} attempts=${out.$metadata.attempts} totalMs=${Date.now() - t0}`
          );
        }
        return out;
      } catch (err) {
        const meta = err?.$metadata;
        console.log(
          `[database] ${context.commandName} error attempts=${meta?.attempts ?? "?"} totalMs=${Date.now() - t0} name=${
            err?.name
          }`
        );
        throw err;
      }
    },
    { step: "finalizeRequest", name: "attemptLogger", priority: "low" }
  );

  _clientConfigKey = configKey;
  console.timeEnd("[database] initializeClient");
  return _docClient;
}

/** Extracts account/campaign/category from the path.
   Expected path: /:account/campaign[/category] or /campaign[/category]
   Returns { account, campaign, category, sortKey } or null if invalid.
*/
function parsePath(event = {}) {
  let rawPath = null;

  // API Gateway HTTP API (v2) with/without wrapper
  if (event.rawEvent?.rawPath) rawPath = event.rawEvent.rawPath;
  else if (event.rawEvent?.requestContext?.http?.path) rawPath = event.rawEvent.requestContext.http.path;
  else if (event.rawPath) rawPath = event.rawPath;
  else if (event.requestContext?.http?.path) rawPath = event.requestContext.http.path;

  if (!rawPath || rawPath === "/") return null;

  const parts = rawPath.replace(/^\//, "").split("/");
  const [firstPart, secondPart, thirdPart] = parts;

  let account = null;
  let campaign = null;
  let category = null;
  let sortKey = null;

  if (firstPart && firstPart.startsWith(":")) {
    account = firstPart.replace(/^:/, "");
    campaign = secondPart?.toUpperCase();
    category = thirdPart?.toUpperCase();
  } else {
    campaign = firstPart?.toUpperCase();
    category = secondPart?.toUpperCase();
  }

  // require at least campaign
  if (!campaign) return null;

  sortKey = campaign;
  if (category) sortKey += `#${category}`;

  return { account, campaign, category, sortKey };
}

//Fetches the invite from DynamoDB, selects the code, and triggers UPDATE (fire-and-forget).
export async function getInviteCode(event = {}) {
  console.time("[database] getInviteCode total");

  const parsed = parsePath(event);
  if (!parsed) {
    console.timeEnd("[database] getInviteCode total");
    return null;
  }

  // Table name priority: event.credentials -> parsed.account -> process.env
  const tableName =
    (event.credentials && event.credentials.AMAZON_DYNAMODB_TABLE) ||
    parsed.account ||
    process.env.AMAZON_DYNAMODB_TABLE ||
    null;

  if (!tableName) {
    throw new Error("AMAZON_DYNAMODB_TABLE não definida nas variáveis de ambiente.");
  }

  const { sortKey } = parsed;
  const doc = getDocClient(event);

  try {
    console.time("[database] dynamodb:GetCommand");
    console.log("tableName, sortKey:", tableName, sortKey);
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

    // ---- SYNCHRONOUS INCREMENT (used to be fire-and-forget) ----
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
    // ------------------------------------------------------------

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
