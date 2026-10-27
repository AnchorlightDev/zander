/**
 * lib/oidc/prismaAdapter.mjs
 *
 * oidc-provider storage adapter backed by Prisma (the `oidcPayloads` table,
 * migration 0072). Implements the Adapter contract:
 * https://github.com/panva/node-oidc-provider/blob/main/docs/README.md#adapter
 *
 * One generic key/value table stores every short-lived artefact the library
 * owns (sessions, grants, access/refresh tokens, codes, interaction state). The
 * `Client` model is the one exception: it is NOT stored here — clients come from
 * the `oauthClients` registry table (see clientAdapter below), so the OAuth
 * client registry is a real, inspectable table as the brief requires.
 */

import { prisma } from "../../controllers/databaseController.js";
import { listClients } from "./clientStore.mjs";

// Each oidc-provider model maps to an integer `type` so one table holds them all.
const TYPES = [
  "Session",
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "ClientCredentials",
  "Client",
  "InitialAccessToken",
  "RegistrationAccessToken",
  "Interaction",
  "ReplayDetection",
  "PushedAuthorizationRequest",
  "Grant",
  "BackchannelAuthenticationRequest",
].reduce((map, name, index) => ({ ...map, [name]: index + 1 }), {});

export class PrismaOidcAdapter {
  constructor(name) {
    this.name = name;
    this.type = TYPES[name];
  }

  async upsert(id, payload, expiresIn) {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    const data = {
      payload: JSON.stringify(payload),
      grantId: payload.grantId ?? null,
      userCode: payload.userCode ?? null,
      uid: payload.uid ?? null,
      expiresAt,
    };

    await prisma.oidcPayloads.upsert({
      where: { type_id: { type: this.type, id } },
      create: { type: this.type, id, ...data },
      update: data,
    });
  }

  async find(id) {
    // Clients are served from the registry table, not oidcPayloads.
    if (this.name === "Client") return this.#findClient(id);

    const row = await prisma.oidcPayloads.findUnique({
      where: { type_id: { type: this.type, id } },
    });
    return this.#toResult(row);
  }

  async findByUserCode(userCode) {
    const row = await prisma.oidcPayloads.findFirst({
      where: { type: this.type, userCode },
    });
    return this.#toResult(row);
  }

  async findByUid(uid) {
    const row = await prisma.oidcPayloads.findFirst({
      where: { type: this.type, uid },
    });
    return this.#toResult(row);
  }

  async consume(id) {
    await prisma.oidcPayloads.update({
      where: { type_id: { type: this.type, id } },
      data: { consumedAt: new Date() },
    });
  }

  async destroy(id) {
    await prisma.oidcPayloads
      .delete({ where: { type_id: { type: this.type, id } } })
      .catch(() => {}); // already gone is fine
  }

  async revokeByGrantId(grantId) {
    await prisma.oidcPayloads.deleteMany({ where: { grantId } });
  }

  #toResult(row) {
    if (!row || !row.payload) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;

    const result = JSON.parse(row.payload);
    if (row.consumedAt) result.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return result;
  }

  async #findClient(clientKey) {
    // Loaded fresh from oauthClients so a redirect-URI or secret change takes
    // effect without a restart. Small table, cached by oidc-provider in-memory
    // per request where it matters.
    const clients = await listClients();
    return clients.find((c) => c.client_id === clientKey);
  }
}

/** Factory oidc-provider calls: `adapter: createAdapter`. */
export function createAdapter(name) {
  return new PrismaOidcAdapter(name);
}
