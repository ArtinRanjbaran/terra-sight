export default function health(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    status: "ok",
    catalog: "NASA CMR",
    deployment_mode: "public_catalog_only",
    analysis_available: false,
    earthdata_token_configured: false,
  });
}
