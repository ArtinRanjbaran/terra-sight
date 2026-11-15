import * as searchModule from "../../api/catalog/search.js";

export const handler = async (event) => {
  const request = {
    method: event.httpMethod,
    query: event.queryStringParameters || {},
  };

  let statusCode = 200;
  const headers = {};
  let body = "";

  const response = {
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      body = JSON.stringify(data);
      return this;
    },
  };

  try {
    let search = searchModule.default;

    // Handle possible module interop differences in Netlify's bundle.
    if (typeof search !== "function" && typeof search?.default === "function") {
      search = search.default;
    }

    if (typeof search !== "function") {
      throw new TypeError(
        `Search export is not callable. Exports: ${Object.keys(searchModule).join(", ")}`
      );
    }

    await search(request, response);

    return {
      statusCode,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body,
    };
  } catch (error) {
    console.error("Catalog search failed:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Catalog search failed",
        message: error.message,
      }),
    };
  }
};