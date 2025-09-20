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

// Lambda handler for Transnet Tenders Scraper
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const lambdaHandler = async (event, context) => {
  let browser = null;
  try {
    console.log("🚀 Lambda scraper started...");

    // Launch headless Chromium in Lambda
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.goto("https://transnetetenders.azurewebsites.net/Home/AdvertisedTenders", {
      waitUntil: "networkidle2",
    });

    await page.waitForSelector("#_advertisedTenders tbody tr");

    const allTenders = [];
    let pageIndex = 1;

    // -------- 1. Collect tenders from all pages --------
    while (true) {
      console.log(`📄 Scraping page ${pageIndex}...`);

      const tenders = await page.evaluate(() => {
        const rows = document.querySelectorAll("#_advertisedTenders tbody tr");
        const tendersData = [];

        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 7) {
            tendersData.push({
              referenceNumber: cells[0]?.innerText.trim(),
              tenderName: cells[1]?.innerText.trim(),
              description: cells[2]?.innerText.trim(),
              briefingSession: cells[3]?.innerText.trim(),
              closingDate: cells[4]?.innerText.trim(),
              tenderStatus: cells[5]?.innerText.trim(),
              detailsLink:
                "https://transnetetenders.azurewebsites.net" +
                (cells[6]?.querySelector("a")?.getAttribute("href") || ""),
            });
          }
        });

        return tendersData;
      });

      console.log(`   → Found ${tenders.length} tenders on page ${pageIndex}`);
      allTenders.push(...tenders);

      // Check if Next button is present & enabled
      const nextButton = await page.$("#_advertisedTenders_next");
      if (!nextButton) {
        console.log("✅ No Next button found, stopping...");
        break;
      }

      const isDisabled = await page.evaluate(
        (el) => el?.classList.contains("disabled"),
        nextButton
      );
      if (isDisabled) {
        console.log(`✅ Reached last page (${pageIndex}), stopping...`);
        break;
      }

      // Click next and wait for new content
      const previousFirstRow = await page.evaluate(() => {
        const firstRow = document.querySelector("#_advertisedTenders tbody tr");
        return firstRow ? firstRow.innerText : "";
      });

      await Promise.all([
        nextButton.click(),
        page.waitForFunction(
          (prevText) => {
            const firstRow = document.querySelector("#_advertisedTenders tbody tr");
            if (!firstRow) return false;
            return firstRow.innerText !== prevText;
          },
          {},
          previousFirstRow
        ),
      ]);

      pageIndex++;
    }

    console.log(`📦 Total tenders collected (before details): ${allTenders.length}`);

    // -------- 2. Fetch details for each tender --------
    for (let i = 0; i < allTenders.length; i++) {
      const tender = allTenders[i];
      if (!tender.detailsLink) continue;

      await page.goto(tender.detailsLink, { waitUntil: "networkidle2" });
      await page.waitForSelector("#_tenderDetails");

      const details = await page.evaluate(() => {
        const getText = (selector) =>
          document.querySelector(selector)?.innerText.trim() || null;

        return {
          tenderName: getText("#lblTenderName"),
          referenceNumber: getText("#_TenderRefNumber"),
          nameOfTender: getText("#_NameOfTender"),
          description: getText("#_DescriptionOfTender"),
          tenderType: getText("#_TenderType"),
          contactPerson:
            document.querySelectorAll(".row.eTenderLabelRows2")[4]?.children[1]
              ?.innerText.trim() || null,
          contactEmail:
            document.querySelectorAll(".row.eTenderLabelRows2")[5]?.children[1]
              ?.innerText.trim() || null,
          datePublished:
            document.querySelectorAll(".row.eTenderLabelRows2")[6]?.children[1]
              ?.innerText.trim() || null,
          closingDate: getText("#_ClosingDate"),
          briefingDate: getText("#_BriefingDate"),
          briefingDetails:
            document.querySelectorAll(".row.eTenderLabelRows2")[9]?.children[1]
              ?.innerText.trim() || null,
          locationOfService:
            document.querySelectorAll(".row.eTenderLabelRows2")[10]?.children[1]
              ?.innerText.trim() || null,
          institution:
            document.querySelectorAll(".row.eTenderLabelRows2")[11]?.children[1]
              ?.innerText.trim() || null,
          tenderCategory:
            document.querySelectorAll(".row.eTenderLabelRows2")[12]?.children[1]
              ?.innerText.trim() || null,
          tenderStatus:
            document.querySelectorAll(".row.eTenderLabelRows2")[13]?.children[1]
              ?.innerText.trim() || null,
        };
      });

      tender.details = details;
    }

    console.log(`🎯 Total tenders scraped with details: ${allTenders.length}`);

    return {
      statusCode: 200,
      body: JSON.stringify(allTenders, null, 2),
    };
  } catch (err) {
    console.error("❌ Error in Lambda:", err);
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

  