// Public, non-secret frontend configuration. Replace the Cognito placeholders
// before deploying. Never put a client secret or AWS access key here.
window.PRADA_CONFIG = Object.freeze({
  apiUrl: "https://bjptf8nm1m.execute-api.eu-central-1.amazonaws.com/dev/feedback/analyze",
  cognitoDomain: "https://YOUR_PREFIX.auth.eu-central-1.amazoncognito.com",
  clientId: "REPLACE_WITH_COGNITO_APP_CLIENT_ID",
  redirectUri: "https://YOUR_CLOUDFRONT_DOMAIN/prada/index.html"
});
