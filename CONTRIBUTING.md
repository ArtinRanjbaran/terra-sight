# Contributing

Thanks for helping improve TERRA SIGHT.

## Set up

Follow the platform-specific instructions in [README.md](./README.md). Catalog search and browse-preview comparison use public NASA CMR/ASF resources and do not require credentials. Do not commit Earthdata tokens, `.env` files, downloaded raster products, or private credentials.

## Validate changes

Run the relevant checks before opening a pull request:

```sh
npm test
python -m pytest -q
npm run build
```

The test suites use local fixtures and mocks; they do not require Earthdata credentials or make live catalog searches.

## Scientific and UX expectations

- Preserve acquisition identifiers, UTC dates, source links, processing levels, units, and geographic coordinates.
- Distinguish source browse imagery from analytical rasters. Browse differences are not pixel-level measurements.
- Never invent observations, displacement values, confidence scores, or citations.
- Explain missing data, failed access, and scientific limitations in the interface.
- Keep external data integrations limited to the documented NASA CMR and ASF services unless a maintainer approves a new source.
- Add focused tests for behavior changes and update the README when setup or methodology changes.

## Pull requests

Describe the user impact, data source, validation performed, and any scientific assumptions. Do not attach tokens or other secrets to issues or pull requests.
