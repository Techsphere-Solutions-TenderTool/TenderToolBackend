const puppeteer = require('puppeteer');
const fs = require('fs');
require('dotenv').config();

const AWS = require('aws-sdk');

// Configure AWS SDK with credentials and region
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const dynamoDB = new AWS.DynamoDB.DocumentClient();

async function saveTenderToDynamoDB(tender) {
  const params = {
    TableName: 'Tenders',
    Item: tender
  };

  try {
    await dynamoDB.put(params).promise();
    console.log(`Saved to DynamoDB: ${tender.enquiryNumber}`);
  } catch (error) {
    console.error(`Failed to save ${tender.enquiryNumber}:`, error.message);
  }
}

async function scrapeAllTenders() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  let pageNumber = 1;
  const tenders = [];

  while (true) {
    const url = `https://tenderbulletin.eskom.co.za/?pageSize=10&pageNumber=${pageNumber}`;
    console.log(`Scraping page ${pageNumber}: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector("ul > li > article", { timeout: 8000 });
    } catch (err) {
      console.log(`No tenders found or timed out on page ${pageNumber}.`);
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
          downloadLink: download ? `https://tenderbulletin.eskom.co.za${download}` : null,
        });
      });

      return items;
    });

    const detailPage = await browser.newPage();
    for (const tender of newTenders) {
      if (tender.readMore) {
        try {
          await detailPage.goto(tender.readMore, { waitUntil: 'networkidle2' });
          await detailPage.waitForSelector('div.border-t', { timeout: 5000 });

          const extraData = await detailPage.evaluate(() => {
            const getField = (label) => {
            const fieldDivs = [...document.querySelectorAll('div.border-t')];
            for (let div of fieldDivs) {
              const dt = div.querySelector('dt');
              const dd = div.querySelector('dd');
              if (dt && dt.textContent.trim().toLowerCase().includes(label.toLowerCase())) {
                return dd?.textContent?.trim() || null;
              }
            }
            return null;
            };
            return {
              TenderID: getField('Tender ID'),
              TenderBoxAddress: getField('Tender Box Address'),
              TargetAudience: getField('Target Audience'),
              ContractType: getField('Contract Type'),
            };

          });

          Object.assign(tender, extraData);
        } catch (err) {
            console.log(`Failed to fetch detail from ${tender.readMore}`);
            console.error(err.message);
        }

      }
    }
    await detailPage.close();


    if (newTenders.length === 0) {
      console.log(`Reached end — no tenders found on page ${pageNumber}`);
      break;
    }

    tenders.push(...newTenders);
    for (const tender of newTenders) {
      await saveTenderToDynamoDB(tender);
    }

    console.log(`Fetched ${newTenders.length} tenders from page ${pageNumber}`);

    pageNumber++;
    if (pageNumber > 50) {
      console.log("Reached page limit of 50. Stopping.");
      break;
    }
  }

  await browser.close();
  fs.writeFileSync("tenders.json", JSON.stringify(tenders, null, 2));
  console.log(`Saved ${tenders.length} tenders to tenders.json`);
}

scrapeAllTenders();
