import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node-fetch before importing the client.
const fetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: fetchMock }));

const {
  isPrintifyConfigured,
  calculateShipping,
  createOrder,
  sendToProduction,
  toPrintifyAddress,
  getShopId,
  _resetShopIdCache,
  SHIPPING_METHOD,
  PrintifyError,
} = await import("../../lib/printify/client.mjs");

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(obj) };
}

const ADDRESS = {
  firstName: "Ben",
  lastName: "Shadow Wolf",
  email: "ben@example.com",
  phone: "0400000000",
  country: "au",
  region: "NSW",
  address1: "1 Test St",
  address2: "",
  city: "Orange",
  zip: "2800",
};

describe("printify client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    _resetShopIdCache();
    process.env.PRINTIFY_API_TOKEN = "test-token";
    process.env.PRINTIFY_SHOP_ID = "999";
  });

  afterEach(() => {
    delete process.env.PRINTIFY_API_TOKEN;
    delete process.env.PRINTIFY_SHOP_ID;
  });

  it("reports configuration from the environment", () => {
    expect(isPrintifyConfigured()).toBe(true);
    delete process.env.PRINTIFY_API_TOKEN;
    expect(isPrintifyConfigured()).toBe(false);
  });

  it("normalises an address and upper-cases the country", () => {
    const a = toPrintifyAddress(ADDRESS);
    expect(a.first_name).toBe("Ben");
    expect(a.last_name).toBe("Shadow Wolf");
    expect(a.country).toBe("AU");
    expect(a.zip).toBe("2800");
  });

  it("calculateShipping POSTs line_items + address_to and returns costs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ standard: 599, express: 1299 }));
    const line = [{ product_id: "p1", variant_id: 123, quantity: 1 }];

    const costs = await calculateShipping(line, ADDRESS);

    expect(costs.standard).toBe(599);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.printify.com/v1/shops/999/orders/shipping.json");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-token");
    expect(opts.headers["User-Agent"]).toBeTruthy();
    const body = JSON.parse(opts.body);
    expect(body.line_items).toEqual(line);
    expect(body.address_to.country).toBe("AU");
  });

  it("createOrder sends the expected order body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "order_abc" }));

    const order = await createOrder({
      externalId: "zander-42",
      label: "CFC #42",
      lineItems: [{ product_id: "p1", variant_id: 123, quantity: 1 }],
      address: ADDRESS,
      shippingMethod: SHIPPING_METHOD.STANDARD,
      sendShippingNotification: true,
    });

    expect(order.id).toBe("order_abc");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.printify.com/v1/shops/999/orders.json");
    const body = JSON.parse(opts.body);
    expect(body.external_id).toBe("zander-42");
    expect(body.label).toBe("CFC #42");
    expect(body.shipping_method).toBe(1);
    expect(body.send_shipping_notification).toBe(true);
    expect(body.line_items[0].variant_id).toBe(123);
    expect(body.address_to.first_name).toBe("Ben");
  });

  it("sendToProduction hits the right path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "order_abc" }));
    await sendToProduction("order_abc");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.printify.com/v1/shops/999/orders/order_abc/send_to_production.json");
    expect(opts.method).toBe("POST");
  });

  it("throws a terminal PrintifyError on 4xx and retryable on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad" }, { ok: false, status: 422 }));
    await expect(sendToProduction("x")).rejects.toMatchObject({ name: "PrintifyError", status: 422, retryable: false });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "oops" }, { ok: false, status: 503 }));
    await expect(sendToProduction("x")).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("surfaces a 409 conflict as a non-retryable PrintifyError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "exists" }, { ok: false, status: 409 }));
    const err = await createOrder({
      externalId: "zander-1",
      lineItems: [{ product_id: "p1", variant_id: 1, quantity: 1 }],
      address: ADDRESS,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PrintifyError);
    expect(err.status).toBe(409);
  });

  it("throws when no token is configured", async () => {
    delete process.env.PRINTIFY_API_TOKEN;
    await expect(calculateShipping([], ADDRESS)).rejects.toMatchObject({ name: "PrintifyError" });
  });

  it("getShopId prefers PRINTIFY_SHOP_ID without calling the API", async () => {
    const id = await getShopId();
    expect(id).toBe("999");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
