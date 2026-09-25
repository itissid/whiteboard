/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewSourceAccessMode } from "./reviewDesktopBootstrap.js";

export const REVIEW_SERVER_PROFILE_SETTING = "review.serverConnectionProfile";
const REVIEW_SERVER_PROFILE_TOKEN_PREFIX = "review.serverConnectionProfile.token.";

export interface CreateRemoteReviewServerProfileInput {
  readonly name: string;
  readonly serverUrl: string;
  readonly token: string;
}

export interface UpdateRemoteReviewServerProfileInput {
  readonly name: string;
  readonly serverUrl: string;
  /** Omit to keep the token already held in OS-backed secret storage. */
  readonly token?: string;
}

export interface ReviewServerConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly sourceAccessMode: Extract<ReviewSourceAccessMode, "api-only">;
}

export interface ReviewServerConnectionProfiles {
  readonly version: 1;
  readonly activeProfileId: string;
  readonly profiles: readonly ReviewServerConnectionProfile[];
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
  const keys = Object.keys(profile);
  if (
    keys.some(key => !["id", "name", "serverUrl", "sourceAccessMode"].includes(key)) ||
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
  };
}

export function parseReviewServerProfiles(value: unknown): ReviewServerConnectionProfiles | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The saved Review Server Connection Profiles are invalid.");
  }
  const record = value as Record<string, unknown>;
  if (!("version" in record) && !("profiles" in record)) {
    const profile = parseReviewServerProfile(value);
    return profile ? { version: 1, activeProfileId: profile.id, profiles: [profile] } : undefined;
  }
  if (
    record.version !== 1 ||
    typeof record.activeProfileId !== "string" ||
    !Array.isArray(record.profiles) ||
    record.profiles.length === 0 ||
    Object.keys(record).some(key => !["version", "activeProfileId", "profiles"].includes(key))
  ) {
    throw new Error("The saved Review Server Connection Profiles are invalid.");
  }
  const profiles = record.profiles.map(value => {
    const profile = parseReviewServerProfile(value);
    if (!profile) throw new Error("The saved Review Server Connection Profiles are invalid.");
    return profile;
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) {
    throw new Error("Saved Review Server Connection Profile identifiers must be unique.");
  }
  if (!profiles.some(profile => profile.id === record.activeProfileId)) {
    throw new Error("The saved active profile does not exist.");
  }
  return { version: 1, activeProfileId: record.activeProfileId, profiles };
}
