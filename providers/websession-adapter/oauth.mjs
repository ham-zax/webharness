import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_VERSION = 1;

function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== STATE_VERSION) throw new Error(`unsupported OAuth state version: ${parsed?.version}`);
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: STATE_VERSION };
    throw error;
  }
}

export class PersistentOAuthProvider {
  constructor({ stateDir, redirectUrl, onRedirect }) {
    this.redirectUrl = redirectUrl;
    this._onRedirect = onRedirect;
    this._stateDir = stateDir;
    this._path = join(stateDir, 'oauth.json');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    this._data = readState(this._path);
  }

  get clientMetadata() {
    return {
      client_name: 'WebSession adapter',
      redirect_uris: [String(this.redirectUrl)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    };
  }

  _save() {
    const tmp = `${this._path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this._data)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this._path);
    chmodSync(this._path, 0o600);
  }

  clientInformation() {
    return this._data.clientInformation;
  }

  saveClientInformation(clientInformation) {
    this._data.clientInformation = clientInformation;
    this._save();
  }

  tokens() {
    return this._data.tokens;
  }

  saveTokens(tokens) {
    this._data.tokens = tokens;
    delete this._data.codeVerifier;
    delete this._data.oauthState;
    this._save();
  }

  state() {
    if (!this._data.oauthState) {
      this._data.oauthState = randomBytes(24).toString('base64url');
      this._save();
    }
    return this._data.oauthState;
  }

  expectedState() {
    return this._data.oauthState;
  }

  redirectToAuthorization(url) {
    return this._onRedirect(url);
  }

  saveCodeVerifier(codeVerifier) {
    this._data.codeVerifier = codeVerifier;
    this._save();
  }

  codeVerifier() {
    if (!this._data.codeVerifier) throw new Error('OAuth code verifier is unavailable; run bin/adapter auth again');
    return this._data.codeVerifier;
  }

  saveDiscoveryState(discoveryState) {
    this._data.discoveryState = discoveryState;
    this._save();
  }

  discoveryState() {
    return this._data.discoveryState;
  }

  expectedIssuer() {
    return this._data.discoveryState?.authorizationServerMetadata?.issuer || this._data.discoveryState?.authorizationServerUrl;
  }

  invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'tokens') delete this._data.tokens;
    if (scope === 'all' || scope === 'client') delete this._data.clientInformation;
    if (scope === 'all' || scope === 'verifier') {
      delete this._data.codeVerifier;
      delete this._data.oauthState;
    }
    if (scope === 'all' || scope === 'discovery') delete this._data.discoveryState;
    this._save();
  }
}
