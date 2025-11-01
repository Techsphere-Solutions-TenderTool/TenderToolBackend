/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html 
 * @param {Object} context
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 * 
 */

// Lambda handler for SANRAL Tenders Scraper
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "af-south-1" });
const BUCKET_NAME = "tender-scraper-bucket";

export const lambdaHandler = async (event, context) => {
  let browser = null;

  try {
    console.log("Starting SANRAL Tenders Scraper...");

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    // Go to SANRAL open tenders
    await page.goto("https://www.nra.co.za/sanral-tenders/list/open-tenders", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await page.waitForSelector("#DataTables_Table_0 tbody tr", { timeout: 60000 });
    await page.waitForSelector("#DataTables_Table_0_paginate span a.paginate_button", { timeout: 60000 });

    const totalPages = await page.evaluate(() => {
      const pageLinks = document.querySelectorAll("#DataTables_Table_0_paginate span a.paginate_button");
      return pageLinks.length;
    });

    const allTenders = [];

    // -------- 1. Loop through paginated tables --------
    for (let pageIndex = 1; pageIndex <= totalPages; pageIndex++) {
      const tenders = await page.evaluate(() => {
        const rows = document.querySelectorAll("#DataTables_Table_0 tbody tr");
        const tendersData = [];

        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 6) {
            tendersData.push({
              tenderLink: "https://www.nra.co.za" + (cells[0]?.querySelector("a")?.getAttribute("href") || ""),
              tenderNumber: cells[0]?.innerText.trim(),
              projectType: cells[1]?.innerText.trim(),
              region: cells[2]?.innerText.trim(),
              description: cells[3]?.innerText.trim(),
              queriesTo: cells[4]?.innerText.trim(),
              closingDate: cells[5]?.innerText.trim(),
            });
          }
        });

        return tendersData;
      });

      allTenders.push(...tenders);

      // Move to next page
      if (pageIndex < totalPages) {
        const previousFirstRow = await page.evaluate(() => {
          const firstRow = document.querySelector("#DataTables_Table_0 tbody tr");
          return firstRow ? firstRow.innerText : "";
        });

        await page.click(`#DataTables_Table_0_paginate span a.paginate_button[data-dt-idx="${pageIndex + 1}"]`);

        await page.waitForFunction(
          (prevText) => {
            const firstRow = document.querySelector("#DataTables_Table_0 tbody tr");
            return firstRow && firstRow.innerText !== prevText;
          },
          { timeout: 60000 },
          previousFirstRow
        );
      }
    }

    // -------- 2. Scrape details from each tender page --------
    for (let i = 0; i < allTenders.length; i++) {
      const tender = allTenders[i];
      if (!tender.tenderLink) continue;

      await page.goto(tender.tenderLink, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForSelector("td", { timeout: 60000 });

      const details = await page.evaluate(() => {
        const allTds = Array.from(document.querySelectorAll("td"));
        if (!allTds.length) return null;

        let targetTd = allTds.reduce((a, b) =>
          a.innerText.trim().length > b.innerText.trim().length ? a : b
        );

        let paragraphs = Array.from(targetTd.querySelectorAll("p"))
          .map((p) => p.innerText.trim())
          .filter((text) => text.length > 0);

        if (paragraphs.length === 0) {
          paragraphs = targetTd.innerText
            .split("\n")
            .map((line) => line.trim())
            .filter((text) => text.length > 0);
        }

        return {
          rawText: targetTd.innerText.trim(),
          paragraphs: paragraphs,
        };
      });

      tender.details = details;
    }

    console.log(`Scraped ${allTenders.length} SANRAL tenders`);

    // -------- 3. Save to S3 --------
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `sanral/sanral-${timestamp}.json`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: JSON.stringify(allTenders, null, 2),
      ContentType: "application/json",
    });

    await s3.send(putCommand);
    console.log(`Saved SANRAL tenders to S3: ${BUCKET_NAME}/${fileName}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Scraping successful and saved to S3",
        total: allTenders.length,
        file: `${BUCKET_NAME}/${fileName}`,
      }),
    };
  } catch (err) {
    console.error("Error scraping SANRAL:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  } finally {
    if (browser !== null) {
      await browser.close();
    }
  }
};


  