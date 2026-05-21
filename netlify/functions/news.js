exports.handler = async function (event, context) {
  const CURRENTS_API_KEY = process.env.CURRENTS_API_KEY;

  if (!CURRENTS_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "CURRENTS_API_KEY is not set in environment variables." }),
    };
  }

  try {
    const url = `https://api.currentsapi.services/v1/latest-news?language=en&page_size=20&apiKey=${CURRENTS_API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Currents API error: ${text}` }),
      };
    }

    const data = await response.json();

    const filtered = (data.news || []).filter((article) => {
      const cats = article.category || [];
      const skip = ["sports", "sport", "entertainment", "lifestyle"];
      return !cats.some((c) => skip.includes(c.toLowerCase()));
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ news: filtered }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
