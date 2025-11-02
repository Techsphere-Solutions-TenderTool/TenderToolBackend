import { lambdaHandler } from "../lambdas/sanral-scraper/index.mjs";

describe("SANRAL Scraper Lambda", () => {
  test("returns success response", async () => {
    const result = await lambdaHandler({}, {});
    const body = JSON.parse(result.body);
    expect(result.statusCode).toBe(200);
    expect(body.message).toMatch(/Scraping successful/);
    expect(body.file).toContain("sanral/");
  });
});
