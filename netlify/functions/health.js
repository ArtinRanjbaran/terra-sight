import health from "../../api/health.js";

export const handler = async () => {
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

  health({}, response);
  return { statusCode, headers, body };
};
