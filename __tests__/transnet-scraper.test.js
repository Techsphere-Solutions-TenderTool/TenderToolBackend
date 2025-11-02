import { lambdaHandler } from "../lambdas/transnet-scraper/index.mjs";

describe("Transnet Scraper Lambda", () => {
  test("returns 200 with success message", async () => {
    const result = await lambdaHandler({}, {});
    const body = JSON.parse(result.body);
    expect(result.statusCode).toBe(200);
    expect(body.message).toMatch(/Scraping successful/);
    expect(body.file).toContain("transnet/");
  });
});
