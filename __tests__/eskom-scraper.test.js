
import { lambdaHandler } from "../lambdas/eskom-scraper/index.mjs";

describe("Eskom Scraper Lambda", () => {
  test("returns success response and saves data to S3", async () => {
    const result = await lambdaHandler({}, {});
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.message).toMatch(/Scraping successful/);
    expect(body.total).toBeGreaterThanOrEqual(0);
    expect(body.file).toContain("eskom/");
  });

  test("handles errors gracefully", async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    puppeteer.launch.mockRejectedValueOnce(new Error("Launch failed"));

    const result = await lambdaHandler({}, {});
    expect(result.statusCode).toBe(500);
    expect(result.body).toContain("Launch failed");
  });
});
