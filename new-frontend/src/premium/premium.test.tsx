import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingApi } from "@/lib/billingApi";
import type { BillingPacksResponse, WalletView } from "@/lib/protocol";
import { SESSION_TOKEN_KEY, resetSessionStateForTests } from "@/lib/session";
import { PENDING_GIVE_UP_MS, PENDING_PAYMENT_KEY } from "./pendingPayment";
import { PremiumProvider } from "./PremiumProvider";
import type { CheckoutResult } from "./razorpayCheckout";
import { useGenderFilterGate } from "./useGenderFilterGate";

const PACKS: BillingPacksResponse = {
  enabled: true,
  premiumFiltersEnabled: true,
  keyId: "rzp_test_x",
  costPerDay: 100,
  packs: [
    { id: "week", coins: 700, inr: 99 },
    { id: "month", coins: 3000, inr: 299 },
  ],
  unlockDays: [1, 7, 30],
};

function fakeApi(overrides: Partial<BillingApi> = {}, packs = PACKS): BillingApi & { wallet: WalletView } {
  const state = { wallet: { coins: 100, unlocks: [] } as WalletView };
  const api: BillingApi = {
    getPacks: vi.fn(async () => packs),
    getWallet: vi.fn(async () => ({ ok: true as const, ...state.wallet })),
    createOrder: vi.fn(async (_t, packId) => ({ ok: true as const, orderId: "order_1", amount: 9900, currency: "INR" as const, keyId: "rzp_test_x", packId, coins: 700 })),
    verifyPayment: vi.fn(async () => {
      state.wallet = { ...state.wallet, coins: state.wallet.coins + 700 };
      return { ok: true as const, coins: state.wallet.coins };
    }),
    unlock: vi.fn(async (_t, req) => {
      const cost = 100 * req.days;
      if (state.wallet.coins < cost) return { ok: false as const, error: "insufficient_coins" as const };
      state.wallet = { coins: state.wallet.coins - cost, unlocks: [{ feature: "gender_filter", expiresAt: Date.now() + req.days * 86_400_000 }] };
      return { ok: true as const, coins: state.wallet.coins, expiresAt: state.wallet.unlocks[0]!.expiresAt };
    }),
    ...overrides,
  };
  return Object.assign(api, {
    get wallet() {
      return state.wallet;
    },
  });
}

const Picker: React.FC = () => {
  const gate = useGenderFilterGate();
  return (
    <div>
      <span data-testid="gate">{`${gate.enabled}:${gate.unlocked}:${gate.coins}:${gate.costPerDay}`}</span>
      <button type="button" onClick={gate.openUnlockSheet}>
        open
      </button>
    </div>
  );
};

function renderWith(api: BillingApi, checkout: (() => Promise<CheckoutResult>) | undefined = async () => ({ status: "paid", paymentId: "pay_1", signature: "sig" })) {
  return render(
    <PremiumProvider api={api} openCheckout={checkout}>
      <Picker />
    </PremiumProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem(SESSION_TOKEN_KEY, JSON.stringify({ token: "tok", expiresAt: Date.now() + 3_600_000 }));
});
afterEach(() => {
  localStorage.clear();
  resetSessionStateForTests();
});

describe("useGenderFilterGate", () => {
  it("is free outside a provider and locked by default inside one", async () => {
    render(<Picker />);
    expect(screen.getByTestId("gate")).toHaveTextContent("false:true:0:0");
    const api = fakeApi();
    renderWith(api);
    await waitFor(() => expect(screen.getAllByTestId("gate")[1]).toHaveTextContent("true:false:0:100"));
  });

  it("is free when the premium_filters_enabled flag is off", async () => {
    renderWith(fakeApi({}, { ...PACKS, premiumFiltersEnabled: false }));
    await waitFor(() => expect(screen.getByTestId("gate")).toHaveTextContent("false:true:0:100"));
  });
});

describe("UnlockSheet", () => {
  it("loads the wallet when opened, buys a pack through checkout, verifies it and unlocks a week", async () => {
    const api = fakeApi();
    renderWith(api);
    fireEvent.click(screen.getByText("open"));
    const sheet = await screen.findByTestId("unlock-sheet");
    expect(sheet).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("wallet-coins")).toHaveTextContent("100 coins"));
    expect(screen.getByTestId("unlock-7")).toBeDisabled();
    expect(screen.getByTestId("unlock-1")).toBeEnabled();

    fireEvent.click(screen.getByTestId("buy-week"));
    await waitFor(() => expect(screen.getByTestId("wallet-coins")).toHaveTextContent("800 coins"));
    expect(api.createOrder).toHaveBeenCalledWith("tok", "week");
    expect(api.verifyPayment).toHaveBeenCalledWith("tok", { orderId: "order_1", paymentId: "pay_1", signature: "sig" });
    expect(screen.getByTestId("premium-feedback")).toHaveTextContent("Coins added");

    fireEvent.click(screen.getByTestId("unlock-7"));
    await waitFor(() => expect(screen.getByTestId("wallet-coins")).toHaveTextContent("100 coins"));
    expect(screen.getByTestId("unlock-status")).toHaveTextContent(/on until/);
    expect(screen.getByTestId("gate")).toHaveTextContent("true:true:100:100");

    fireEvent.click(screen.getByTestId("unlock-close"));
    await waitFor(() => expect(screen.queryByTestId("unlock-sheet")).not.toBeInTheDocument());
  });

  it("reports a dismissed checkout and a refused unlock without changing the balance", async () => {
    const api = fakeApi();
    renderWith(api, async () => ({ status: "dismissed" }));
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("unlock-sheet");
    await waitFor(() => expect(screen.getByTestId("wallet-coins")).toHaveTextContent("100 coins"));
    fireEvent.click(screen.getByTestId("buy-month"));
    await waitFor(() => expect(screen.getByTestId("premium-feedback")).toHaveTextContent("Payment cancelled"));
    expect(api.verifyPayment).not.toHaveBeenCalled();
    expect(screen.getByTestId("wallet-coins")).toHaveTextContent("100 coins");
  });

  it("explains when the server has no payment keys", async () => {
    renderWith(fakeApi({}, { ...PACKS, enabled: false, keyId: null }));
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("unlock-sheet");
    expect(await screen.findByTestId("buy-disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("buy-week")).not.toBeInTheDocument();
  });
});

describe("pending payment", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the proof of payment and retries /verify with backoff after a rate limit, then credits", async () => {
    let answers = 0;
    const api = fakeApi({
      verifyPayment: vi.fn(async () => {
        answers++;
        if (answers === 1) return { ok: false as const, error: "rate_limited" as const };
        if (answers === 2) return { ok: false as const, error: "payment_pending" as const };
        if (answers === 3) throw new Error("offline");
        return { ok: true as const, coins: 800 };
      }),
    });
    renderWith(api, async () => ({ status: "paid", paymentId: "pay_slow", signature: "sig" }));
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("unlock-sheet");
    fireEvent.click(screen.getByTestId("buy-week"));
    await waitFor(() => expect(screen.getByTestId("premium-feedback")).toHaveTextContent("Payment is processing"));
    expect(screen.getByTestId("premium-pending")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(PENDING_PAYMENT_KEY)!)).toMatchObject({ orderId: "order_1", paymentId: "pay_slow", signature: "sig" });
    expect(api.verifyPayment).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.verifyPayment).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(api.verifyPayment).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(api.verifyPayment).toHaveBeenCalledTimes(4);
    await waitFor(() => expect(screen.getByTestId("wallet-coins")).toHaveTextContent("800 coins"));
    expect(screen.queryByTestId("premium-pending")).not.toBeInTheDocument();
    expect(localStorage.getItem(PENDING_PAYMENT_KEY)).toBeNull();
    expect(api.verifyPayment).toHaveBeenLastCalledWith("tok", { orderId: "order_1", paymentId: "pay_slow", signature: "sig" });
  });

  it("drops the record on a terminal answer and settles a leftover payment on the next load", async () => {
    const refused = fakeApi({ verifyPayment: vi.fn(async () => ({ ok: false as const, error: "bad_signature" as const })) });
    renderWith(refused);
    fireEvent.click(screen.getByText("open"));
    await screen.findByTestId("unlock-sheet");
    fireEvent.click(screen.getByTestId("buy-week"));
    await waitFor(() => expect(screen.getByTestId("premium-feedback")).toHaveTextContent("did not go through"));
    expect(localStorage.getItem(PENDING_PAYMENT_KEY)).toBeNull();
    cleanup();

    localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({ orderId: "order_9", paymentId: "pay_9", signature: "s9", startedAt: Date.now() }));
    const api = fakeApi();
    renderWith(api);
    await waitFor(() => expect(api.verifyPayment).toHaveBeenCalledWith("tok", { orderId: "order_9", paymentId: "pay_9", signature: "s9" }));
    await waitFor(() => expect(localStorage.getItem(PENDING_PAYMENT_KEY)).toBeNull());
    await waitFor(() => expect(screen.getByTestId("gate")).toHaveTextContent("true:false:800:100"));
  });

  it("stops retrying ten minutes after the payment", async () => {
    const api = fakeApi({ verifyPayment: vi.fn(async () => ({ ok: false as const, error: "rate_limited" as const })) });
    localStorage.setItem(
      PENDING_PAYMENT_KEY,
      JSON.stringify({ orderId: "order_old", paymentId: "pay_old", signature: "s", startedAt: Date.now() - PENDING_GIVE_UP_MS }),
    );
    renderWith(api);
    // One last attempt on load, then the record is dropped (the webhook is the fallback).
    await waitFor(() => expect(api.verifyPayment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(localStorage.getItem(PENDING_PAYMENT_KEY)).toBeNull());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.verifyPayment).toHaveBeenCalledTimes(1);
  });
});
