import type {
  AuthenticationResponseJSON,
  Base64URLString,
  CredentialDeviceType,
  UserVerificationRequirement,
  WebAuthnCredential,
} from '../types/index.ts';
import { decodeClientDataJSON } from '../helpers/decodeClientDataJSON.ts';
import { toHash } from '../helpers/toHash.ts';
import { verifySignature } from '../helpers/verifySignature.ts';
import { parseAuthenticatorData } from '../helpers/parseAuthenticatorData.ts';
import { parseBackupFlags } from '../helpers/parseBackupFlags.ts';
import type { AuthenticationExtensionsAuthenticatorOutputs } from '../helpers/decodeAuthenticatorExtensions.ts';
import { matchExpectedRPID } from '../helpers/matchExpectedRPID.ts';
import { isoBase64URL, isoUint8Array } from '../helpers/iso/index.ts';

/**
 * Configurable options when calling `verifyAuthenticationResponse()`
 */
export type VerifyAuthenticationResponseOpts = Parameters<typeof verifyAuthenticationResponse>[0];

/**
 * Verify that the user has legitimately completed the authentication process
 *
 * **Options:**
 *
 * @param response - Response returned by **@simplewebauthn/browser**'s `startAssertion()`
 * @param expectedChallenge - The base64url-encoded `options.challenge` returned by `generateAuthenticationOptions()`
 * @param expectedOrigin - Website URL (or array of URLs) that the registration should have occurred on
 * @param expectedRPID - RP ID (or array of IDs) that was specified in the registration options
 * @param credential - An internal {@link WebAuthnCredential} corresponding to `id` in the authentication response
 * @param expectedType **(Optional)** - The response type expected ('webauthn.get')
 * @param requireUserVerification **(Optional)** - Enforce user verification by the authenticator (via PIN, fingerprint, etc...) Defaults to `true`
 * @param advancedFIDOConfig **(Optional)** - Options for satisfying more stringent FIDO RP feature requirements
 * @param advancedFIDOConfig.userVerification **(Optional)** - Enable alternative rules for evaluating the User Presence and User Verified flags in authenticator data: UV (and UP) flags are optional unless this value is `"required"`
 */
export async function verifyAuthenticationResponse(
  options: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string | ((challenge: string) => boolean | Promise<boolean>);
    expectedOrigin: string | string[];
    expectedRPID: string | string[];
    credential: WebAuthnCredential;
    expectedType?: string | string[];
    requireUserVerification?: boolean;
    advancedFIDOConfig?: {
      userVerification?: UserVerificationRequirement;
    };
  },
): Promise<VerifiedAuthenticationResponse> {
  const {
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID,
    expectedType,
    credential,
    requireUserVerification = true,
    advancedFIDOConfig,
  } = options;
  const { id, rawId, type: credentialType, response: assertionResponse } = response;

  // Ensure credential specified an ID
  if (!id) {
    throw new Error('Missing credential ID');
  }

  // Ensure ID is base64url-encoded
  if (id !== rawId) {
    throw new Error('Credential ID was not base64url-encoded');
  }

  // Make sure credential type is public-key
  if (credentialType !== 'public-key') {
    throw new Error(
      `Unexpected credential type ${credentialType}, expected "public-key"`,
    );
  }

  if (!response) {
    throw new Error('Credential missing response');
  }

  if (typeof assertionResponse?.clientDataJSON !== 'string') {
    throw new Error('Credential response clientDataJSON was not a string');
  }

  const clientDataJSON = decodeClientDataJSON(assertionResponse.clientDataJSON);

  const { type, origin, challenge, tokenBinding } = clientDataJSON;

  // Make sure we're handling an authentication
  if (Array.isArray(expectedType)) {
    if (!expectedType.includes(type)) {
      const joinedExpectedType = expectedType.join(', ');
      throw new Error(
        `Unexpected authentication response type "${type}", expected one of: ${joinedExpectedType}`,
      );
    }
  } else if (expectedType) {
    if (type !== expectedType) {
      throw new Error(
        `Unexpected authentication response type "${type}", expected "${expectedType}"`,
      );
    }
  } else if (type !== 'webauthn.get') {
    throw new Error(`Unexpected authentication response type: ${type}`);
  }

  // Ensure the device provided the challenge we gave it
  if (typeof expectedChallenge === 'function') {
    if (!(await expectedChallenge(challenge))) {
      throw new Error(
        `Custom challenge verifier returned false for registration response challenge "${challenge}"`,
      );
    }
  } else if (challenge !== expectedChallenge) {
    throw new Error(
      `Unexpected authentication response challenge "${challenge}", expected "${expectedChallenge}"`,
    );
  }

  // Check that the origin is our site
  if (Array.isArray(expectedOrigin)) {
    if (!expectedOrigin.includes(origin)) {
      const joinedExpectedOrigin = expectedOrigin.join(', ');
      throw new Error(
        `Unexpected authentication response origin "${origin}", expected one of: ${joinedExpectedOrigin}`,
      );
    }
  } else {
    if (origin !== expectedOrigin) {
      throw new Error(
        `Unexpected authentication response origin "${origin}", expected "${expectedOrigin}"`,
      );
    }
  }

  if (!isoBase64URL.isBase64URL(assertionResponse.authenticatorData)) {
    throw new Error(
      'Credential response authenticatorData was not a base64url string',
    );
  }

  if (!isoBase64URL.isBase64URL(assertionResponse.signature)) {
    throw new Error('Credential response signature was not a base64url string');
  }

  if (
    assertionResponse.userHandle &&
    typeof assertionResponse.userHandle !== 'string'
  ) {
    throw new Error('Credential response userHandle was not a string');
  }

  if (tokenBinding) {
    if (typeof tokenBinding !== 'object') {
      throw new Error('ClientDataJSON tokenBinding was not an object');
    }

    if (
      ['present', 'supported', 'notSupported'].indexOf(tokenBinding.status) < 0
    ) {
      throw new Error(`Unexpected tokenBinding status ${tokenBinding.status}`);
    }
  }

  const authDataBuffer = isoBase64URL.toBuffer(
    assertionResponse.authenticatorData,
  );
  const parsedAuthData = parseAuthenticatorData(authDataBuffer);
  const { rpIdHash, flags, counter, extensionsData } = parsedAuthData;

  // Make sure the response's RP ID is ours
  let expectedRPIDs: string[] = [];
  if (typeof expectedRPID === 'string') {
    expectedRPIDs = [expectedRPID];
  } else {
    expectedRPIDs = expectedRPID;
  }

  const matchedRPID = await matchExpectedRPID(rpIdHash, expectedRPIDs);

  if (advancedFIDOConfig !== undefined) {
    const { userVerification: fidoUserVerification } = advancedFIDOConfig;

    /**
     * Use FIDO Conformance-defined rules for verifying UP and UV flags
     */
    if (fidoUserVerification === 'required') {
      // Require `flags.uv` be true (implies `flags.up` is true)
      if (!flags.uv) {
        throw new Error(
          'User verification required, but user could not be verified',
        );
      }
    } else if (
      fidoUserVerification === 'preferred' ||
      fidoUserVerification === 'discouraged'
    ) {
      // Ignore `flags.uv`
    }
  } else {
    /**
     * Use WebAuthn spec-defined rules for verifying UP and UV flags
     */
    // WebAuthn only requires the user presence flag be true
    if (!flags.up) {
      throw new Error('User not present during authentication');
    }

    // Enforce user verification if required
    if (requireUserVerification && !flags.uv) {
      throw new Error(
        'User verification required, but user could not be verified',
      );
    }
  }

  const clientDataHash = await toHash(
    isoBase64URL.toBuffer(assertionResponse.clientDataJSON),
  );
  const signatureBase = isoUint8Array.concat([authDataBuffer, clientDataHash]);

  const signature = isoBase64URL.toBuffer(assertionResponse.signature);

  if (
    (counter > 0 || credential.counter > 0) &&
    counter <= credential.counter
  ) {
    // Error out when the counter in the DB is greater than or equal to the counter in the
    // dataStruct. It's related to how the authenticator maintains the number of times its been
    // used for this client. If this happens, then someone's somehow increased the counter
    // on the device without going through this site
    throw new Error(
      `Response counter value ${counter} was lower than expected ${credential.counter}`,
    );
  }

  const { credentialDeviceType, credentialBackedUp } = parseBackupFlags(flags);

  const toReturn: VerifiedAuthenticationResponse = {
    verified: await verifySignature({
      signature,
      data: signatureBase,
      credentialPublicKey: credential.publicKey,
    }),
    authenticationInfo: {
      newCounter: counter,
      credentialID: credential.id,
      userVerified: flags.uv,
      credentialDeviceType,
      credentialBackedUp,
      authenticatorExtensionResults: extensionsData,
      origin: clientDataJSON.origin,
      rpID: matchedRPID,
    },
  };

  return toReturn;
}

/**
 * Result of authentication verification
 *
 * @param verified If the authentication response could be verified
 * @param authenticationInfo.credentialID The ID of the authenticator used during authentication.
 * Should be used to identify which DB authenticator entry needs its `counter` updated to the value
 * below
 * @param authenticationInfo.newCounter The number of times the authenticator identified above
 * reported it has been used. **Should be kept in a DB for later reference to help prevent replay
 * attacks!**
 * @param authenticationInfo.credentialDeviceType Whether this is a single-device or multi-device
 * credential. **Should be kept in a DB for later reference!**
 * @param authenticationInfo.credentialBackedUp Whether or not the multi-device credential has been
 * backed up. Always `false` for single-device credentials. **Should be kept in a DB for later
 * reference!**
 * @param authenticationInfo.origin The origin of the website that the authentication occurred on
 * @param authenticationInfo.rpID The RP ID that the authentication occurred on
 * @param authenticationInfo?.authenticatorExtensionResults The authenticator extensions returned
 * by the browser
 */
export type VerifiedAuthenticationResponse = {
  verified: boolean;
  authenticationInfo: {
    credentialID: Base64URLString;
    newCounter: number;
    userVerified: boolean;
    credentialDeviceType: CredentialDeviceType;
    credentialBackedUp: boolean;
    origin: string;
    rpID: string;
    authenticatorExtensionResults?: AuthenticationExtensionsAuthenticatorOutputs;
  };
};
