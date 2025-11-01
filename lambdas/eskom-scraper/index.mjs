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

// Lambda handler for Eskom Tenders Scraper
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "af-south-1" }); // e.g., "us-east-1"
const BUCKET_NAME = "tender-scraper-bucket";

export const lambdaHandler = async (event, context) => {
  let browser = null;

  try {
    console.log(" Lambda Eskom scraper started...");

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    let pageNumber = 1;
    const tenders = [];

    while (true) {
      const url = `https://tenderbulletin.eskom.co.za/?pageSize=10&pageNumber=${pageNumber}`;
      console.log(` Scraping page ${pageNumber}: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2" });

      try {
        await page.waitForSelector("ul > li > article", { timeout: 8000 });
      } catch (err) {
        console.log(` No tenders found or timed out on page ${pageNumber}.`);
        break;
      }

      const newTenders = await page.evaluate(() => {
        const items = [];
        const tenderElements = document.querySelectorAll("ul > li");

        tenderElements.forEach((li) => {
          const enquiryNumber = li.querySelector("h3")?.textContent?.trim();
          if (!enquiryNumber) return;

          const scopeDetails = li.querySelector("p")?.textContent?.trim();
          const category = li.querySelector("dt")?.textContent?.trim();
          const description = li.querySelector("dd")?.textContent?.trim();
          const location = li.querySelector("dd span.font-medium")?.textContent?.trim();
          const closing = li.querySelectorAll("dd span.font-medium")[1]?.textContent?.trim();
          const published = li.querySelectorAll("dd span.font-medium")[2]?.textContent?.trim();
          const readMoreRel = li.querySelector('a[href^="/tender/"]')?.getAttribute("href");
          const readMore = readMoreRel ? `https://tenderbulletin.eskom.co.za${readMoreRel}` : null;
          const download = li.querySelector('a[href*="DownloadAll"]')?.getAttribute("href");

          items.push({
            enquiryNumber,
            scopeDetails,
            category,
            description,
            location,
            closing,
            published,
            readMore,
            downloadLink: download
              ? download.startsWith("http")
                ? download
                : `https://tenderbulletin.eskom.co.za${download}`
              : null,
          });
        });

        return items;
      });

      // Fetch details page info
      const detailPage = await browser.newPage();
      for (const tender of newTenders) {
        if (tender.readMore) {
          try {
            await detailPage.goto(tender.readMore, { waitUntil: "networkidle2" });
            await detailPage.waitForSelector("div.border-t", { timeout: 5000 });

            const extraData = await detailPage.evaluate(() => {
              const getField = (label) => {
                const fieldDivs = [...document.querySelectorAll("div.border-t")];
                for (let div of fieldDivs) {
                  const dt = div.querySelector("dt");
                  const dd = div.querySelector("dd");
                  if (dt && dt.textContent.trim().toLowerCase().includes(label.toLowerCase())) {
                    return dd?.textContent?.trim() || null;
                  }
                }
                return null;
              };

              return {
                TenderID: getField("Tender ID"),
                TenderBoxAddress: getField("Tender Box Address"),
                TargetAudience: getField("Target Audience"),
                ContractType: getField("Contract Type"),
              };
            });

            Object.assign(tender, extraData);
          } catch (err) {
            console.log(` Failed to fetch detail from ${tender.readMore}`);
            console.error(err.message);
          }
        }
      }
      await detailPage.close();

      if (newTenders.length === 0) {
        console.log(` Reached end — no tenders found on page ${pageNumber}`);
        break;
      }

      tenders.push(...newTenders);

      console.log(` Fetched ${newTenders.length} tenders from page ${pageNumber}`);

      pageNumber++;
      if (pageNumber > 50) {
        console.log(" Reached page limit of 50. Stopping.");
        break;
      }
    }

    console.log(` Total Eskom tenders scraped: ${tenders.length}`);

    // ---- Save to S3 ----
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `eskom/eskom-${timestamp}.json`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: JSON.stringify(tenders, null, 2),
      ContentType: "application/json",
    });

    await s3.send(putCommand);
    console.log(` Saved Eskom tenders to S3: ${BUCKET_NAME}/${fileName}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Scraping successful and saved to S3",
        total: tenders.length,
        file: `${BUCKET_NAME}/${fileName}`,
      }),
    };
  } catch (err) {
    console.error(" Error in Lambda:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};


  