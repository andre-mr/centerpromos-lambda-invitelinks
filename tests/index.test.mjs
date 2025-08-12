import { handler } from "../src/index.mjs";
import dotenv from "dotenv";

dotenv.config();

const credentials = {
  AMAZON_ACCESS_KEY_ID: process.env.AMAZON_ACCESS_KEY_ID,
  AMAZON_SECRET_ACCESS_KEY: process.env.AMAZON_SECRET_ACCESS_KEY,
  AMAZON_DYNAMODB_TABLE: process.env.AMAZON_DYNAMODB_TABLE,
  AMAZON_REGION: process.env.AMAZON_REGION,
};

describe("Lambda Handler Integration Tests", () => {
  const TEST_CAMPAIGN = process.env.TEST_CAMPAIGN?.toLowerCase();
  const TEST_CATEGORY = process.env.TEST_CATEGORY?.toLowerCase();

  beforeAll(() => {
    if (!TEST_CAMPAIGN) {
      throw new Error("TEST_CAMPAIGN must be defined in the .env file");
    }
    if (!TEST_CATEGORY) {
      throw new Error("TEST_CATEGORY must be defined in the .env file");
    }
    if (!process.env.AMAZON_DYNAMODB_TABLE) {
      throw new Error("AMAZON_DYNAMODB_TABLE must be defined in the .env file");
    }
    if (!process.env.AMAZON_REGION) {
      throw new Error("AMAZON_REGION must be defined in the .env file");
    }
  });

  test("should redirect when accessing campaign only", async () => {
    const mockEvent = {
      rawPath: `/${TEST_CAMPAIGN}`,
      credentials,
    };

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toMatch(/^https:\/\/chat\.whatsapp\.com\/.+/);
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.body).toBe("");
  });

  test("should redirect when accessing campaign with category", async () => {
    const mockEvent = {
      rawPath: `/${TEST_CAMPAIGN}/${TEST_CATEGORY}`,
      credentials,
    };

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(302);
    expect(response.headers.Location).toMatch(/^https:\/\/chat\.whatsapp\.com\/.+/);
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.body).toBe("");
  });

  test("should return 404 when accessing root path", async () => {
    const mockEvent = {
      rawPath: "/",
    };

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(404);
    expect(response.headers["Content-Type"]).toBe("text/html");
    expect(response.body).toContain("Link não encontrado");
  });
});
