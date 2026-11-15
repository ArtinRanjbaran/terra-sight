import search from "../../api/catalog/search.js";

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
      return { statusCode, headers, body };
    },
  };

  await search(request, response);
  return { statusCode, headers, body };
};
