console.log('Script started...');
const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://www.nra.co.za/sanral-tenders/list/open-tenders', {
    waitUntil: 'networkidle2'
  });

  
  await page.waitForSelector('#DataTables_Table_0 tbody tr');
  await page.waitForSelector('#DataTables_Table_0_paginate span a.paginate_button');

  
  await page.waitForFunction(() => {
    const buttons = document.querySelectorAll('#DataTables_Table_0_paginate span a.paginate_button');
    return Array.from(buttons).some(btn => btn.innerText.trim().length > 0);
  });

  
  const totalPages = await page.evaluate(() => {
    const pageLinks = document.querySelectorAll('#DataTables_Table_0_paginate span a.paginate_button');
    return pageLinks.length;
  });

  console.log(` Total pages found: ${totalPages}`);

  const allTenders = [];

  for (let pageIndex = 1; pageIndex <= totalPages; pageIndex++) {
    console.log(` Scraping page ${pageIndex}...`);

    
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#DataTables_Table_0 tbody tr');
      return Array.from(rows).some(row => row.innerText.trim().length > 0);
    });

    
    const tenders = await page.evaluate(() => {
      const rows = document.querySelectorAll('#DataTables_Table_0 tbody tr');
      const tendersData = [];

      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 6) {
          tendersData.push({
            tenderNumber: 'https://www.nra.co.za' + (cells[0]?.querySelector('a')?.getAttribute('href') || ''),
            projectType: cells[1]?.innerText.trim(),
            region: cells[2]?.innerText.trim(),
            description: cells[3]?.innerText.trim(),
            queriesTo: cells[4]?.innerText.trim(),
            closingDate: cells[5]?.innerText.trim()
          });
        }
      });

      return tendersData;
    });

    allTenders.push(...tenders);

    
    if (pageIndex < totalPages) {
      const previousFirstRow = await page.evaluate(() => {
        const firstRow = document.querySelector('#DataTables_Table_0 tbody tr');
        return firstRow ? firstRow.innerText : '';
      });

      await page.click(`#DataTables_Table_0_paginate span a.paginate_button[data-dt-idx="${pageIndex + 1}"]`);

      await page.waitForFunction(
        prevText => {
          const firstRow = document.querySelector('#DataTables_Table_0 tbody tr');
          if (!firstRow) return false;
          return firstRow.innerText !== prevText;
        },
        {},
        previousFirstRow
      );
    }
  }

  console.log(`\n Total Tenders Scraped: ${allTenders.length}`);
  console.log(allTenders);

  await browser.close();
})();