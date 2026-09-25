/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewSourceAccessMode } from "./reviewDesktopBootstrap.js";
import {
  parseReviewExternalSourceOpenerConfiguration,
  type ReviewExternalSourceOpenerConfiguration,
} from "./reviewExternalSourceOpener.js";

export const REVIEW_SERVER_PROFILE_SETTING = "review.serverConnectionProfile";
const REVIEW_SERVER_PROFILE_TOKEN_PREFIX = "review.serverConnectionProfile.token.";

export interface CreateRemoteReviewServerProfileInput {
  readonly name: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly externalSourceOpener?: ReviewExternalSourceOpenerConfiguration;
}

export interface ReviewServerConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly sourceAccessMode: Extract<ReviewSourceAccessMode, "api-only">;
  readonly externalSourceOpener?: ReviewExternalSourceOpenerConfiguration;
}

export function reviewServerProfileTokenKey(profileId: string): string {
  return `${REVIEW_SERVER_PROFILE_TOKEN_PREFIX}${profileId}`;
}

export function normalizeReviewServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Review Server URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("The Review Server URL must be an HTTP or HTTPS URL without credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The Review Server URL must identify the server origin without a path, query, or fragment.");
  }
  return url.origin;
}

export function parseReviewServerProfile(value: unknown): ReviewServerConnectionProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved Review Server Connection Profile is invalid.");
  }
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.id !== "string" || !profile.id ||
    typeof profile.name !== "string" || !profile.name.trim() ||
    typeof profile.serverUrl !== "string" ||
    profile.sourceAccessMode !== "api-only"
  ) {
    throw new Error("The saved Review Server Connection Profile is invalid.");
  }
  return {
    id: profile.id,
    name: profile.name.trim(),
    serverUrl: normalizeReviewServerUrl(profile.serverUrl),
    sourceAccessMode: "api-only",
    ...(profile.externalSourceOpener === undefined
      ? {}
      : { externalSourceOpener: parseReviewExternalSourceOpenerConfiguration(profile.externalSourceOpener) }),
  };
}
