import { getInviteCode } from "./database.mjs";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple in-memory cache for templates
const templateCache = new Map();

async function loadTemplate(templateName) {
  const key = `${templateName}.html`;
  if (templateCache.has(key)) return templateCache.get(key);

  console.time(`[index] loadTemplate:${templateName}`);
  try {
    const templatePath = path.join(__dirname, key);
    const html = await fs.readFile(templatePath, "utf8");
    templateCache.set(key, html);
    return html;
  } catch (err) {
    console.error(`Error loading template ${templateName}:`, err);
    const fallback = `<html><body><h1>${templateName === "404" ? "Não Encontrado" : "Erro Interno"}</h1></body></html>`;
    templateCache.set(key, fallback);
    return fallback;
  } finally {
    console.timeEnd(`[index] loadTemplate:${templateName}`);
  }
}

export const handler = async (event, context) => {
  console.time("[index] handler total");
  // ensures pending tasks (increment) do not hold up the response
  if (context) context.callbackWaitsForEmptyEventLoop = false;

  try {
    console.time("[index] getInviteCode");
    const result = await getInviteCode(event);
    console.timeEnd("[index] getInviteCode");

    if (!result?.inviteCode) {
      const template404 = await loadTemplate("404");
      console.time("[index] response:404");
      const response = {
        statusCode: 404,
        headers: { "Content-Type": "text/html" },
        body: template404,
      };
      console.timeEnd("[index] response:404");
      console.timeEnd("[index] handler total");
      return response;
    }

    console.time("[index] response:302");
    const response = {
      statusCode: 302,
      headers: {
        Location: `https://chat.whatsapp.com/${result.inviteCode}`,
        "Cache-Control": "no-store",
      },
      body: "",
    };
    console.timeEnd("[index] response:302");
    console.timeEnd("[index] handler total");
    return response;
  } catch (error) {
    console.error("Error handling request:", error);

    const template500 = await loadTemplate("500");
    console.time("[index] response:500");
    const response = {
      statusCode: 500,
      headers: { "Content-Type": "text/html" },
      body: template500,
    };
    console.timeEnd("[index] response:500");
    console.timeEnd("[index] handler total");
    return response;
  }
};
