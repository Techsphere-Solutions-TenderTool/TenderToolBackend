const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    // Extract tender fields
    const { title, closingDate, description, requirements } = body;

    // Build tender context text dynamically
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


