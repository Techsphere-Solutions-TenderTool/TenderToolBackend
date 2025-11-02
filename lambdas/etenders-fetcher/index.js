const axios = require("axios");
const https = require("https");
const AWS = require("aws-sdk");
const s3 = new AWS.S3();
const lambda = new AWS.Lambda();

const BASE_URL = "https://ocds-api.etenders.gov.za/api/OCDSReleases";
const BUCKET = process.env.BUCKET || "tender-scraper-bucket";
const PREFIX = process.env.PREFIX || "etenders/";
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || "100", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "50", 10);
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || "3000", 10);

// IMPORTANT: Start with sequential processing for stability
const USE_CONCURRENT = process.env.USE_CONCURRENT === 'true'; // Default to false

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Create axios instance with specific configuration for eTenders
const createAxiosInstance = () => {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 45000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      'Connection': 'close'
    },
    httpsAgent: new https.Agent({
      keepAlive: false,
      rejectUnauthorized: true,
      timeout: 45000
    }),
    validateStatus: function (status) {
      return status >= 200 && status < 500; // Don't throw on 4xx
    }
  });
};

async function fetchPageWithRetry(page, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Fetching page ${page} (attempt ${attempt}/${maxRetries})...`);
      
      const axiosInstance = createAxiosInstance();
      
      const response = await axiosInstance.get('', {
        params: {
          pageNumber: page,
          pageSize: PAGE_SIZE,
          dateFrom: "2010-10-28",
          dateTo: "2025-10-28"
        }
      });
      
      // Check if we got valid data
      if (response.status === 200 && response.data) {
        // Validate the response has expected structure
        if (typeof response.data === 'object') {
          console.log(`Page ${page} fetched successfully`);
          return response.data;
        } else {
          throw new Error(`Invalid response format for page ${page}`);
        }
      } else if (response.status === 404) {
        console.log(`Page ${page} not found (404)`);
        return null; // Page doesn't exist
      } else if (response.status === 429) {
        // Rate limited
        const waitTime = (attempt * 10000); // 10s, 20s, 30s
        console.warn(`Rate limited on page ${page}. Waiting ${waitTime/1000}s...`);
        await sleep(waitTime);
        continue;
      } else {
        throw new Error(`Unexpected status ${response.status} for page ${page}`);
      }
      
    } catch (err) {
      lastError = err;
      console.error(`Error fetching page ${page}:`, err.message);
      
      // Determine if we should retry
      const isRetriableError = 
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'ERR_BAD_RESPONSE' ||
        err.code === 'ERR_CANCELED' ||
        err.message.includes('timeout') ||
        err.message.includes('socket hang up');
      
      if (!isRetriableError) {
        console.error(`Non-retriable error for page ${page}:`, err.message);
        throw err;
      }
      
      if (attempt < maxRetries) {
        const backoffTime = Math.min(attempt * 5000, 20000); // Max 20s backoff
        console.log(`Waiting ${backoffTime/1000}s before retry...`);
        await sleep(backoffTime);
      }
    }
  }
  
  console.error(`Failed to fetch page ${page} after ${maxRetries} attempts`);
  throw lastError || new Error(`Failed to fetch page ${page}`);
}

async function savePage(data, page) {
  if (!data) {
    console.log(`No data to save for page ${page}`);
    return null;
  }
  
  const timestamp = Date.now();
  const filename = `${PREFIX}etenders-p${String(page).padStart(4, '0')}-${timestamp}.json`;
  
  try {
      await s3.putObject({
      Bucket: BUCKET,
      Key: filename,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
      Metadata: {
        page: String(page),
        timestamp: String(timestamp)
      }
    }).promise();

    console.log(`Saved page ${page} to ${filename}`);

    // await sleep(1000);

    // // Push message to SQS so Normalizer triggers ---
    // const sqs = new AWS.SQS();
    // const queueUrl = process.env.INGEST_QUEUE_URL;

    // const messageBody = JSON.stringify({
    //   bucket: BUCKET,
    //   key: filename,
    //   source: "etenders",
    //   page,
    //   timestamp,
    // });

    // await sqs.sendMessage({
    //   QueueUrl: queueUrl,
    //   MessageBody: messageBody,
    // }).promise();

    // console.log(`Sent SQS message for page ${page} to queue ${queueUrl}`);
    return filename;
  } catch (err) {
    console.error(`Failed to save page ${page} to S3:`, err);
    throw err;
  }
}

async function processPageSequentially(page) {
  try {
    const data = await fetchPageWithRetry(page);
    if (data) {
      const filename = await savePage(data, page);
      return { success: true, page, filename };
    } else {
      return { success: false, page, error: 'No data returned' };
    }
  } catch (err) {
    return { success: false, page, error: err.message };
  }
}

async function processPagesInBatch(startPage, endPage, batchSize = 3) {
  const results = [];
  
  for (let i = startPage; i <= endPage; i += batchSize) {
    const batchEnd = Math.min(i + batchSize - 1, endPage);
    console.log(`Processing batch: pages ${i} to ${batchEnd}`);
    
    const batch = [];
    for (let page = i; page <= batchEnd; page++) {
      batch.push(processPageSequentially(page));
    }
    
    const batchResults = await Promise.allSettled(batch);
    results.push(...batchResults.map(r => r.value || r.reason));
    
    // Add delay between batches
    if (batchEnd < endPage) {
      console.log(`Throttling for ${THROTTLE_MS/1000}s...`);
      await sleep(THROTTLE_MS);
    }
  }
  
  return results;
}

async function invokeContinuation(nextPage, totalSaved, failedPages = []) {
  console.log(`Invoking continuation from page ${nextPage}...`);
  
  try {
    const result = await lambda.invoke({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({
        startPage: nextPage,
        totalSaved: totalSaved,
        failedPages: failedPages,
        timestamp: new Date().toISOString()
      }),
    }).promise();
    
    console.log("Continuation invoked successfully");
    return true;
  } catch (err) {
    console.error("Failed to invoke continuation:", err);
    return false;
  }
}

exports.handler = async (event = {}) => {
  const startPage = event.startPage || 1;
  let totalSaved = event.totalSaved || 0;
  const previousFailedPages = event.failedPages || [];
  
  console.log(`
╔══════════════════════════════════════════╗
║  eTenders API Scraper                   ║
║  Starting page: ${String(startPage).padEnd(24)}║
║  Total saved: ${String(totalSaved).padEnd(26)}║
║  Max pages: ${String(MAX_PAGES).padEnd(28)}║
║  Mode: ${USE_CONCURRENT ? 'Concurrent' : 'Sequential'.padEnd(33)}║
╚══════════════════════════════════════════╝
  `);
  
  const startTime = Date.now();
  const MAX_RUNTIME_MS = 260000; 
  let currentPage = startPage;
  const pageResults = [];
  const failedPages = [...previousFailedPages];
  
  try {
    while (currentPage <= MAX_PAGES) {
      const elapsed = Date.now() - startTime;
      
      // Check timeout
      if (elapsed > MAX_RUNTIME_MS) {
        console.log(`Approaching timeout limit (${Math.floor(elapsed/1000)}s elapsed)`);
        
        if (elapsed > MAX_RUNTIME_MS) {
        console.log(`Timeout approaching (${elapsed/1000}s) – invoking continuation from page ${currentPage}...`);
        await invokeContinuation(currentPage, totalSaved, failedPages);
        return {
            statusCode: 200,
            message: "Continuation invoked before timeout",
            summary: {
            lastPage: currentPage - 1,
            totalSaved,
            failedPages,
            continuedFrom: currentPage
            }
        };
        }

        break;
      }
      
      // Estimate remaining pages we can process
      const timePerPage = elapsed / Math.max(1, currentPage - startPage) || 10000;
      const remainingTime = MAX_RUNTIME_MS - elapsed;
      const pagesWeCanProcess = Math.max(1, Math.floor(remainingTime / timePerPage));
      const batchEnd = Math.min(currentPage + pagesWeCanProcess - 1, MAX_PAGES);
      
      console.log(`\nProgress: Page ${currentPage}/${MAX_PAGES} | Elapsed: ${Math.floor(elapsed/1000)}s`);
      
      let results;
      
      if (USE_CONCURRENT && pagesWeCanProcess > 1) {
        // Use concurrent processing
        results = await processPagesInBatch(currentPage, Math.min(currentPage + 2, batchEnd), 3);
        currentPage = Math.min(currentPage + 3, batchEnd + 1);
      } else {
        // Use sequential processing (more stable for problematic APIs)
        const result = await processPageSequentially(currentPage);
        results = [result];
        currentPage++;
        
        // Add throttle between sequential requests
        if (currentPage <= MAX_PAGES) {
          await sleep(THROTTLE_MS + 1000);
        }
      }
      
      // Process results
      for (const result of results) {
        pageResults.push(result);
        if (result.success) {
          totalSaved++;
        } else {
          failedPages.push(result.page);
          console.error(`Failed page ${result.page}: ${result.error}`);
        }
      }
      
      // Log progress every 10 pages
      if (currentPage % 10 === 0 || currentPage === MAX_PAGES) {
        console.log(`
   Progress Report:
   - Pages processed: ${pageResults.length}
   - Successful: ${pageResults.filter(r => r.success).length}
   - Failed: ${failedPages.length}
   - Total saved: ${totalSaved}
        `);
      }
    }
    
    // Final summary
    const successful = pageResults.filter(r => r.success).length;
    const failed = pageResults.filter(r => !r.success).length;
    
    console.log(`
╔══════════════════════════════════════════╗
║  Execution Complete                      ║
║  Success: ${String(successful).padEnd(30)}║
║  Failed: ${String(failed).padEnd(31)}║
║  Total saved: ${String(totalSaved).padEnd(26)}║
╚══════════════════════════════════════════╝
    `);
    
    return {
      statusCode: 200,
      message: "Processing complete",
      summary: {
        pagesProcessed: pageResults.length,
        successful,
        failed,
        totalSaved,
        lastPage: currentPage - 1,
        failedPages: failedPages.length > 0 ? failedPages : undefined,
        duration: Math.floor((Date.now() - startTime) / 1000) + 's'
      }
    };
    
  } catch (err) {
    console.error("Fatal error:", err);
    
    // Try to save progress before failing
    if (currentPage > startPage) {
      await invokeContinuation(currentPage, totalSaved, failedPages);
    }
    
    return {
      statusCode: 500,
      error: err.message,
      lastProcessedPage: currentPage - 1,
      totalSaved,
      failedPages
    };
  }
};