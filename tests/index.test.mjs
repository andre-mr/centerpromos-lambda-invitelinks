import { jest } from "@jest/globals";
import { handler } from "../src/index.mjs";
import dotenv from "dotenv";
dotenv.config();

jest.mock("@aws-sdk/client-dynamodb", () => {
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

jest.mock("@aws-sdk/lib-dynamodb", () => {
  return {
    DynamoDBDocumentClient: {
      from: jest.fn().mockReturnValue({
        send: jest.fn().mockResolvedValue({ UnprocessedItems: {} }),
      }),
    },
    GetCommand: jest.fn().mockImplementation((params) => params),
  };
});

const credentials = {
  accessKeyId: process.env.AMAZON_ACCESS_KEY_ID,
  secretAccessKey: process.env.AMAZON_SECRET_ACCESS_KEY,
};

describe("Lambda Handler Tests", () => {
  beforeEach(() => {
    process.env.AMAZON_REGION = process.env.AMAZON_REGION;
    process.env.AMAZON_DYNAMODB_TABLE = process.env.AMAZON_DYNAMODB_TABLE;
    jest.clearAllMocks();
  });

  test("should successfully redirect when invite link exists without category", async () => {
    const mockEvent = {
      credentials,
      rawPath: "/testcampaign",
    };
    const response = await handler(mockEvent);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location.startsWith("https://chat.whatsapp.com/")).toBe(true);
    expect(response.body).toBe("");
  });

  test("should successfully redirect when invite link exists with category", async () => {
    const mockEvent = {
      credentials,
      rawPath: "/testcampaign/testcategory",
    };
    const response = await handler(mockEvent);
    expect(response.statusCode).toBe(302);
    expect(response.headers.Location.startsWith("https://chat.whatsapp.com/")).toBe(true);
    expect(response.body).toBe("");
  });

  test("should handle missing AMAZON_REGION", async () => {
    delete process.env.AMAZON_REGION;
    const mockEvent = {
      credentials,
      rawPath: "/testcampaign",
    };
    const response = await handler(mockEvent);
    expect(response.statusCode).toBe(500);
    expect(response.headers["Content-Type"]).toBe("text/html");
    expect(response.body).toContain("<title>Erro no servidor</title>");
    expect(response.body).toContain("Ops! Algo deu errado");
  });

  test("should handle missing AMAZON_DYNAMODB_TABLE", async () => {
    delete process.env.AMAZON_DYNAMODB_TABLE;
    const mockEvent = {
      credentials,
      rawPath: "/testcampaign",
    };
    const response = await handler(mockEvent);
    expect(response.statusCode).toBe(500);
    expect(response.headers["Content-Type"]).toBe("text/html");
    expect(response.body).toContain("<title>Erro no servidor</title>");
    expect(response.body).toContain("Ops! Algo deu errado");
  });

  test("should handle DynamoDB errors", async () => {
    const mockEvent = {
      credentials,
      rawPath: "/testcampaign",
    };
    const response = await handler(mockEvent);
    expect(response.statusCode).toBe(500);
    expect(response.headers["Content-Type"]).toBe("text/html");
    expect(response.body).toContain("<title>Erro no servidor</title>");
    expect(response.body).toContain("Ops! Algo deu errado");
  });

  test("should return 404 when accessing root path without campaign or category", async () => {
    const mockEvent = {
      credentials,
      rawPath: "/",
    };
    const response = await handler(mockEvent);
    expect(response.statusCode).toBe(404);
    expect(response.headers["Content-Type"]).toBe("text/html");
    expect(response.body).toContain("<title>Link não encontrado</title>");
    expect(response.body).toContain("Link não encontrado");
  });
});
