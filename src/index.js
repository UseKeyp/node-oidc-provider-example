// see previous example for the things that are not commented
require("dotenv").config();

const assert = require("assert");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const Provider = require("oidc-provider");

assert(process.env.HEROKU_APP_NAME, "process.env.HEROKU_APP_NAME missing");
assert(process.env.PORT, "process.env.PORT missing");
assert(
  process.env.SECURE_KEY,
  "process.env.SECURE_KEY missing, run `heroku addons:create securekey`"
);
assert.equal(
  process.env.SECURE_KEY.split(",").length,
  2,
  "process.env.SECURE_KEY format invalid"
);

const jwks = require("./jwks.json");
// simple account model for this application, user list is defined like so
const Account = require("./account");

const oidc = new Provider("https://node-oidc-provider-example.vercel.app", {
  clients: [
    {
      client_id: "123",
      // client_secret: "node-oidc-secret",
      redirect_uris: [
        "https://jwt.io",
        "https://app.oauth-demo.keyp.gg/redirect/node_oidc",
        "http://localhost/redirect/node_oidc",
        "http://0.0.0.0:3000/redirect/node_oidc",
        "http://localhost:3000/redirect/node_oidc",
        "http://0.0.0.0:8910/redirect/node_oidc",
        "http://localhost:8910/redirect/node_oidc",
        "https://oauth2-client-redwood-eta.vercel.app/redirect/node_oidc",
      ], // using jwt.io as redirect_uri to show the ID Token contents
      response_types: ["code"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    },
  ],
  cookies: {
    keys: process.env.SECURE_KEY.split(","),
  },
  jwks,
  // oidc-provider only looks up the accounts by their ID when it has to read the claims,
  // passing it our Account model method is sufficient, it should return a Promise that resolves
  // with an object with accountId property and a claims method.
  findAccount: Account.findAccount,

  // let's tell oidc-provider you also support the email scope, which will contain email and
  // email_verified claims
  claims: {
    openid: ["sub"],
    email: ["email", "email_verified"],
  },

  // let's tell oidc-provider where our own interactions will be
  // setting a nested route is just good practice so that users
  // don't run into weird issues with multiple interactions open
  // at a time.
  interactions: {
    url(ctx, interaction) {
      return `/interaction/${interaction.uid}`;
    },
  },
  features: {
    // disable the packaged interactions
    devInteractions: { enabled: false },
  },
  ttl: {
    // Sessions
    Session: 1209600, // 14 days in seconds
    Interaction: 600, // 10 minutes
    DeviceCode: 600, // 10 minutes
    // Tokens
    AuthorizationCode: 60, //  1 minute
    IdToken: 3600, // 1 hour
    AccessToken: 86400, // 24 hours
  },
});

oidc.proxy = true;
// oidc.listen(process.env.PORT);

// let's work with express here, below is just the interaction definition
const expressApp = express();
expressApp.set("trust proxy", true);
expressApp.set("view engine", "ejs");
expressApp.set("views", path.resolve(__dirname, "views"));

const parse = bodyParser.urlencoded({ extended: false });

function setNoCache(req, res, next) {
  res.set("Pragma", "no-cache");
  res.set("Cache-Control", "no-cache, no-store");
  next();
}

expressApp.get("/interaction/:uid", setNoCache, async (req, res, next) => {
  try {
    const details = await oidc.interactionDetails(req, res);
    // eslint-disable-next-line no-console
    console.log(
      "see what else is available to you for interaction views",
      details
    );
    const { uid, prompt, params } = details;

    const client = await oidc.Client.find(params.client_id);

    if (prompt.name === "login") {
      return res.render("login", {
        client,
        uid,
        details: prompt.details,
        params,
        title: "Sign-in",
        flash: undefined,
      });
    }

    return res.render("interaction", {
      client,
      uid,
      details: prompt.details,
      params,
      title: "Authorize",
    });
  } catch (err) {
    return next(err);
  }
});

expressApp.post(
  "/interaction/:uid/login",
  setNoCache,
  parse,
  async (req, res, next) => {
    try {
      const details = await oidc.interactionDetails(req, res);
      console.log(
        "see what else is available to you for interaction views",
        details
      );
      const { uid, prompt, params } = details;
      assert.strictEqual(prompt.name, "login");
      const client = await oidc.Client.find(params.client_id);

      const accountId = await Account.authenticate(
        req.body.email,
        req.body.password
      );

      if (!accountId) {
        res.render("login", {
          client,
          uid,
          details: prompt.details,
          params: {
            ...params,
            login_hint: req.body.email,
          },
          title: "Sign-in",
          flash: "Invalid email or password.",
        });
        return;
      }

      const result = {
        login: { accountId },
      };

      await oidc.interactionFinished(req, res, result, {
        mergeWithLastSubmission: false,
      });
    } catch (err) {
      next(err);
    }
  }
);

expressApp.post(
  "/interaction/:uid/confirm",
  setNoCache,
  parse,
  async (req, res, next) => {
    try {
      const interactionDetails = await oidc.interactionDetails(req, res);
      const {
        prompt: { name, details },
        params,
        session: { accountId },
      } = interactionDetails;
      assert.strictEqual(name, "consent");

      let { grantId } = interactionDetails;
      let grant;

      if (grantId) {
        // we'll be modifying existing grant in existing session
        grant = await oidc.Grant.find(grantId);
      } else {
        // we're establishing a new grant
        grant = new oidc.Grant({
          accountId,
          clientId: params.client_id,
        });
      }

      if (details.missingOIDCScope) {
        grant.addOIDCScope(details.missingOIDCScope.join(" "));
        // use grant.rejectOIDCScope to reject a subset or the whole thing
      }
      if (details.missingOIDCClaims) {
        grant.addOIDCClaims(details.missingOIDCClaims);
        // use grant.rejectOIDCClaims to reject a subset or the whole thing
      }
      if (details.missingResourceScopes) {
        // eslint-disable-next-line no-restricted-syntax
        for (const [indicator, scopes] of Object.entries(
          details.missingResourceScopes
        )) {
          grant.addResourceScope(indicator, scopes.join(" "));
          // use grant.rejectResourceScope to reject a subset or the whole thing
        }
      }

      grantId = await grant.save();

      const consent = {};
      if (!interactionDetails.grantId) {
        // we don't have to pass grantId to consent, we're just modifying existing one
        consent.grantId = grantId;
      }

      const result = { consent };
      await oidc.interactionFinished(req, res, result, {
        mergeWithLastSubmission: true,
      });
    } catch (err) {
      next(err);
    }
  }
);

expressApp.get(
  "/interaction/:uid/abort",
  setNoCache,
  async (req, res, next) => {
    try {
      const result = {
        error: "access_denied",
        error_description: "End-User aborted interaction",
      };
      await oidc.interactionFinished(req, res, result, {
        mergeWithLastSubmission: false,
      });
    } catch (err) {
      next(err);
    }
  }
);

// leave the rest of the requests to be handled by oidc-provider, there's a catch all 404 there
expressApp.use(oidc.callback());

// express listen
expressApp.listen(process.env.PORT);
