const OpenAI = require("openai");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ssm = new SSMClient({ region: process.env.AWS_REGION });
let cachedClient = null; // cache client to avoid re-fetching key every cold start

async function getOpenAIClient() {
  if (cachedClient) return cachedClient;

  try {
    const paramName = process.env.OPENAI_API_PARAM;
    console.log("Fetching OpenAI API key from SSM:", paramName);

    const command = new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    });
    const response = await ssm.send(command);
    const apiKey = response.Parameter.Value;

    cachedClient = new OpenAI({ apiKey });
    console.log("OpenAI client initialized successfully");
    return cachedClient;
  } catch (error) {
    console.error("Failed to fetch OpenAI API key:", error);
    throw new Error("Unable to initialize OpenAI client");
  }
}

exports.handler = async (event) => {
  try {
    const client = await getOpenAIClient();

    const body = JSON.parse(event.body || "{}");
    const { title, closingDate, description, requirements } = body;

    let tenderInfo = [];
    if (title) tenderInfo.push(`Title: ${title}`);
    if (closingDate) tenderInfo.push(`Closing Date: ${closingDate}`);
    if (description) tenderInfo.push(`Description: ${description}`);
    if (requirements) tenderInfo.push(`Requirements: ${requirements}`);

    if (tenderInfo.length === 0) {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "No tender data provided" }),
      };
    }

    const tenderText = tenderInfo.join("\n");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a tender summariser AI. Summarise ONLY the provided tender information in a single short paragraph (max 100 words). Do not invent details or add headings. If a field is missing, simply do not mention it. Write in a professional business tone.",
        },
        {
          role: "assistant",
          content:
            "Write the summary as one flowing paragraph with no headings, no bullet points, and no line breaks. Do not use the words 'title', 'description', 'requirements', or 'closing date'.",
        },
        {
          role: "user",
          content: tenderText,
        },
      ],
    });

    const summary = response.choices[0].message.content.trim();

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ summary }),
    };
  } catch (err) {
    console.error("Error occurred:", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Failed to summarise tender" }),
    };
  }
};
