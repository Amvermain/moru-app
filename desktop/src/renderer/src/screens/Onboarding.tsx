/**
 * First-run onboarding - fullscreen 4-step wizard rendered inside
 * EngineGate instead of Sidebar+main until the "moru:onboarded" flag is
 * set (stores/router.ts). Steps: welcome -> provider API key -> Discord
 * login -> screen tour. Every step is optional; finishing OR skipping
 * sets the flag, and Settings > General offers a replay.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { MoruLogo } from "@/components/MoruLogo";
import { api } from "@/lib/api";
import { moru } from "@/lib/bridge";
import { CLI_PROVIDERS, LOCAL_PROVIDERS, PROVIDER_TIERS } from "@/lib/models";
import { useAccount } from "@/stores/account";
import { useRouter } from "@/stores/router";
import { useSettings } from "@/stores/settings";
import type { Provider } from "../../../shared/engine";

const STEP_COUNT = 4;

/** Provider tile colors - keep in sync with Settings.tsx PROVIDER_DECOR. */
const PROVIDER_TINT: Record<string, string> = {
  anthropic: "#C9704D",
  openai: "#10A37F",
  google: "#4285F4",
  gemini: "#4285F4",
  openrouter: "#6366F1",
  ollama: "#A78BFA",
  "openai-compatible": "#38BDF8",
  "claude-code": "#C9704D",
  codex: "#10A37F",
  "gemini-cli": "#4285F4",
};

/** Mono step breadcrumb + title + description (mirrors Settings TabHeader). */
function StepHeader({ step, title, desc }: { step: number; title: string; desc: string }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="mb-2 flex items-center gap-[10px] font-mono text-[11px] font-semibold tracking-[0.08em] text-text3 uppercase">
        <span className="text-accent">▍</span>
        <span>{t("onboarding.step", { current: step, total: STEP_COUNT })}</span>
      </div>
      <h1 className="mb-[6px] text-2xl font-bold tracking-[-0.02em] text-text">{title}</h1>
      <p className="mb-7 text-[13px] leading-relaxed text-text2">{desc}</p>
    </>
  );
}

/** Numbered blocky bullet row shared by the welcome and tour steps. */
function BulletRow({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <div className="flex items-center gap-3 border border-line2 bg-raised px-4 py-3 text-left">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center border border-edge bg-card font-mono text-[11px] font-bold text-accent">
        {n}
      </div>
      <div className="min-w-0">
        <div className="text-[12px] font-bold text-text">{title}</div>
        <div className="mt-[2px] font-mono text-[11px] text-text3">{desc}</div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center text-center">
      <MoruLogo width={96} height={80} />
      <h1 className="mt-8 text-[28px] font-bold tracking-[-0.02em] text-text">
        {t("onboarding.welcome.title")}
      </h1>
      <p className="mt-3 max-w-[440px] text-[13px] leading-relaxed text-text2">
        {t("onboarding.welcome.intro")}
      </p>
      <div className="mt-8 flex w-full flex-col gap-[2px]">
        {(["scan", "translate", "export"] as const).map((k, i) => (
          <BulletRow
            key={k}
            n={i + 1}
            title={t(`onboarding.welcome.${k}`)}
            desc={t(`onboarding.welcome.${k}Desc`)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Provider setup. Cloud providers take an API key (test mirrors
 * W3Settings' keyTest mutation: POST /providers/test, persist to the OS
 * keychain, point settings at the provider's balanced tier). Local
 * providers (Ollama, OpenAI-compatible servers) take a base URL instead
 * and connect by probing the live model list. Both refresh the
 * react-query caches W3 reads so the connection shows up there.
 */
function KeyStep({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const set = useSettings((s) => s.set);
  const ollamaBaseUrl = useSettings((s) => s.ollamaBaseUrl);
  const openaiCompatBaseUrl = useSettings((s) => s.openaiCompatBaseUrl);
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set());

  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const providers = providersQuery.data ?? [];
  const selected = providers.find((p) => p.id === selectedId);
  // Local providers swap the key field for a base URL; CLI subscriptions
  // have neither — they only need their own CLI to be logged in.
  const selectedIsLocal = selected !== undefined && LOCAL_PROVIDERS.has(selected.id);
  const selectedIsCli = selected !== undefined && CLI_PROVIDERS[selected.id] === true;

  const keyTest = useMutation({
    mutationFn: async ({ provider, key }: { provider: Provider; key: string }) => {
      const result = await api.testProvider(provider.id, key);
      if (!result.ok) throw new Error(result.error ?? t("onboarding.key.testFail"));
      await moru.secrets.set(`apikey:${provider.id}`, key);
      return provider;
    },
    onSuccess: async (provider) => {
      // W3 opens on the provider the user just connected
      const model = PROVIDER_TIERS[provider.id]?.balanced ?? provider.models[0];
      set({
        provider: provider.id,
        preset: "balanced",
        ...(model !== undefined ? { model } : {}),
      });
      setSavedIds((prev) => new Set(prev).add(provider.id));
      setKeyInput("");
      onSaved();
      await queryClient.invalidateQueries({ queryKey: ["secret", provider.id] });
      await queryClient.invalidateQueries({ queryKey: ["secrets"] });
      await queryClient.invalidateQueries({ queryKey: ["provider-models"] });
    },
  });

  // Local providers need a reachable server, not a cloud key: probe the
  // live model list (optional key for keyed OpenAI-compatible servers)
  // and adopt the first detected model on success.
  const localTest = useMutation({
    mutationFn: async ({
      provider,
      baseUrl,
      key,
    }: {
      provider: Provider;
      baseUrl: string;
      key?: string;
    }) => {
      const res = await api.providerModels(provider.id, key, baseUrl);
      if (res.source !== "live" || res.models.length === 0) {
        throw new Error(t("onboarding.key.connectFail"));
      }
      return { provider, baseUrl, key, models: res.models };
    },
    onSuccess: async ({ provider, baseUrl, key, models }) => {
      if (key !== undefined && provider.id === "openai-compatible") {
        // vLLM --api-key / remote gateways: mirrors Settings' CompatCard
        await moru.secrets.set("apikey:openai-compatible", key);
      }
      // W3 opens on the server the user just connected
      set({
        ...(provider.id === "ollama"
          ? { ollamaBaseUrl: baseUrl }
          : { openaiCompatBaseUrl: baseUrl }),
        provider: provider.id,
        preset: "custom",
        model: models[0],
      });
      setSavedIds((prev) => new Set(prev).add(provider.id));
      onSaved();
      await queryClient.invalidateQueries({ queryKey: ["secret", provider.id] });
      await queryClient.invalidateQueries({ queryKey: ["secrets"] });
      await queryClient.invalidateQueries({ queryKey: ["provider-models"] });
    },
  });

  const connectLocal = () => {
    if (selected === undefined || urlInput.trim().length === 0 || localTest.isPending) return;
    const key = keyInput.trim();
    localTest.mutate({
      provider: selected,
      baseUrl: urlInput.trim(),
      key: selected.id === "openai-compatible" && key.length > 0 ? key : undefined,
    });
  };

  const select = (id: string) => {
    setSelectedId(id);
    setKeyInput("");
    setUrlInput(
      id === "ollama" ? ollamaBaseUrl : id === "openai-compatible" ? openaiCompatBaseUrl : "",
    );
    keyTest.reset();
    localTest.reset();
  };

  return (
    <div>
      <StepHeader step={2} title={t("onboarding.key.title")} desc={t("onboarding.key.desc")} />

      {providersQuery.isPending ? (
        <div className="flex items-center gap-[6px] font-mono text-[11px] text-text3">
          <div className="h-[6px] w-[6px] animate-pxpulse bg-text3" />
          {t("onboarding.key.loading")}
        </div>
      ) : providersQuery.isError ? (
        <div className="font-mono text-[11px] text-red">{t("onboarding.key.loadError")}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-[2px]">
            {providers.map((p) => {
              const active = p.id === selectedId;
              const connected = savedIds.has(p.id) || p.has_key;
              return (
                <button
                  key={p.id}
                  onClick={() => select(p.id)}
                  className={`flex items-center gap-3 border bg-raised px-4 py-3 text-left ${
                    active ? "border-accent" : "border-line2 hover:border-edge2"
                  }`}
                >
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center text-[12px] font-bold text-white"
                    style={{ background: PROVIDER_TINT[p.id] ?? "#1F8A5B" }}
                  >
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-bold text-text">{p.name}</div>
                    <div className="mt-[2px] font-mono text-[10px] text-text3">
                      {savedIds.has(p.id)
                        ? t("onboarding.key.saved")
                        : CLI_PROVIDERS[p.id] === true
                          ? p.has_key
                            ? t("onboarding.key.cliReady")
                            : t("onboarding.key.cliNeedsLogin")
                          : LOCAL_PROVIDERS.has(p.id)
                            ? t("onboarding.key.localNoKey")
                            : p.has_key
                              ? t("onboarding.key.envKey")
                              : t("onboarding.key.needsKey")}
                    </div>
                  </div>
                  {connected && <div className="h-[6px] w-[6px] shrink-0 bg-accent" />}
                </button>
              );
            })}
          </div>

          {selected !== undefined && (
            <div className="mt-4 flex flex-col gap-2">
              {selectedIsCli ? (
                <div className="border border-line2 bg-raised px-4 py-3">
                  <div className="mb-2 font-mono text-[11px] leading-relaxed text-text3">
                    {selected.has_key
                      ? t("onboarding.key.cliConnectedDetail", {
                          account: selected.account ?? selected.name,
                        })
                      : t("onboarding.key.cliLoginDetail", { cmd: selected.login_hint ?? "" })}
                  </div>
                  <button
                    onClick={() => {
                      void queryClient.invalidateQueries({ queryKey: ["providers"] });
                    }}
                    className="border border-accent px-3 py-2 text-[11px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)]"
                  >
                    {t("onboarding.key.cliRecheck")}
                  </button>
                </div>
              ) : selectedIsLocal ? (
                <>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") connectLocal();
                      }}
                      placeholder={
                        selected.id === "ollama"
                          ? "http://localhost:11434"
                          : "http://localhost:1234/v1"
                      }
                      className="min-w-0 flex-1 border border-edge bg-bar px-3 py-2 font-mono text-[12px] text-text placeholder:text-text4 focus:border-accent focus:outline-none"
                    />
                    <button
                      disabled={localTest.isPending || urlInput.trim().length === 0}
                      onClick={connectLocal}
                      className="shrink-0 border border-accent bg-transparent px-4 py-2 text-[12px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {localTest.isPending
                        ? t("onboarding.key.connecting")
                        : t("onboarding.key.connect")}
                    </button>
                  </div>
                  {selected.id === "openai-compatible" && (
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") connectLocal();
                      }}
                      placeholder={t("settings.models.compatKeyPlaceholder")}
                      className="border border-edge bg-bar px-3 py-2 font-mono text-[12px] text-text placeholder:text-text4 focus:border-accent focus:outline-none"
                    />
                  )}
                  {localTest.isError && (
                    <div className="font-mono text-[11px] text-red">
                      {localTest.error.message}
                    </div>
                  )}
                  {localTest.isSuccess && (
                    <div className="flex items-center gap-[6px] font-mono text-[11px] text-accent">
                      <div className="h-[6px] w-[6px] bg-accent" />
                      {t("onboarding.key.connectOk", { n: localTest.data.models.length })}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          keyInput.trim().length > 0 &&
                          !keyTest.isPending
                        ) {
                          keyTest.mutate({ provider: selected, key: keyInput.trim() });
                        }
                      }}
                      placeholder={t("onboarding.key.placeholder", { name: selected.name })}
                      className="min-w-0 flex-1 border border-edge bg-bar px-3 py-2 font-mono text-[12px] text-text placeholder:text-text4 focus:border-accent focus:outline-none"
                    />
                    <button
                      disabled={keyTest.isPending || keyInput.trim().length === 0}
                      onClick={() => keyTest.mutate({ provider: selected, key: keyInput.trim() })}
                      className="shrink-0 border border-accent bg-transparent px-4 py-2 text-[12px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {keyTest.isPending ? t("onboarding.key.testing") : t("onboarding.key.test")}
                    </button>
                  </div>
                  {keyTest.isError && (
                    <div className="font-mono text-[11px] text-red">{keyTest.error.message}</div>
                  )}
                  {keyTest.isSuccess && (
                    <div className="flex items-center gap-[6px] font-mono text-[11px] text-accent">
                      <div className="h-[6px] w-[6px] bg-accent" />
                      {t("onboarding.key.testOk")}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="mt-5 font-mono text-[11px] text-text3">{t("onboarding.key.hint")}</div>
    </div>
  );
}

/** Optional Discord login via the browser OAuth round-trip (stores/account.ts). */
function AccountStep() {
  const { t } = useTranslation();
  const account = useAccount();

  return (
    <div>
      <StepHeader step={3} title={t("onboarding.account.title")} desc={t("onboarding.account.desc")} />

      {account.status === "connected" ? (
        <div className="flex items-center gap-3 border border-line2 bg-raised px-4 py-4">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center text-[15px] font-bold text-bar"
            style={{ background: "linear-gradient(135deg, #3DDC84, #1F8A5B)" }}
          >
            {(account.name ?? "?").charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="text-[13px] font-bold text-text">{account.name}</div>
            <div className="mt-[2px] flex items-center gap-[6px] font-mono text-[11px] text-accent">
              <div className="h-[6px] w-[6px] bg-accent" />
              {t("onboarding.account.connected")}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center border border-line2 bg-raised px-8 py-8 text-center">
          <button
            onClick={() => void account.login()}
            disabled={account.pending}
            className="bg-discord px-5 py-[10px] text-xs font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("onboarding.account.login")}
          </button>
          {account.pending && (
            <div className="mt-3 flex items-center gap-[6px] font-mono text-[10px] text-amber">
              <div className="h-1 w-1 animate-pxpulse bg-amber" />
              {t("onboarding.account.waitingBrowser")}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-[2px]">
        <BulletRow
          n={1}
          title={t("onboarding.account.shareBenefit")}
          desc={t("onboarding.account.shareBenefitDesc")}
        />
        <BulletRow
          n={2}
          title={t("onboarding.account.scoreBenefit")}
          desc={t("onboarding.account.scoreBenefitDesc")}
        />
      </div>
      <div className="mt-4 font-mono text-[11px] text-text3">{t("onboarding.account.optional")}</div>
    </div>
  );
}

function TourStep() {
  const { t } = useTranslation();
  return (
    <div>
      <StepHeader step={4} title={t("onboarding.tour.title")} desc={t("onboarding.tour.desc")} />
      <div className="flex flex-col gap-[2px]">
        {(["home", "wizard", "library"] as const).map((k, i) => (
          <BulletRow
            key={k}
            n={i + 1}
            title={t(`onboarding.tour.${k}`)}
            desc={t(`onboarding.tour.${k}Desc`)}
          />
        ))}
      </div>
    </div>
  );
}

export function OnboardingScreen() {
  const { t } = useTranslation();
  const completeOnboarding = useRouter((s) => s.completeOnboarding);
  const [step, setStep] = useState(0);
  const [keySaved, setKeySaved] = useState(false);

  const last = step === STEP_COUNT - 1;
  const next = () => (last ? completeOnboarding() : setStep(step + 1));

  const nextLabel = last
    ? t("onboarding.tour.finish")
    : step === 0
      ? t("onboarding.welcome.start")
      : step === 1 && !keySaved
        ? t("onboarding.key.later")
        : t("common.action.next");

  return (
    <div className="flex min-w-0 flex-1 animate-fade-in-up flex-col bg-bg">
      <div className="flex min-h-0 flex-1 overflow-y-auto px-10 py-8">
        <div className="m-auto w-full max-w-[560px]">
          {step === 0 && <WelcomeStep />}
          {step === 1 && <KeyStep onSaved={() => setKeySaved(true)} />}
          {step === 2 && <AccountStep />}
          {step === 3 && <TourStep />}
        </div>
      </div>

      {/* bottom bar: skip · progress dots · back / next */}
      <div className="flex shrink-0 items-center border-t border-line px-8 py-4">
        <div className="flex-1">
          {!last && (
            <button
              onClick={() => completeOnboarding()}
              className="bg-transparent text-[11px] font-medium text-text3 hover:text-text"
            >
              {t("onboarding.skip")}
            </button>
          )}
        </div>

        <div className="flex items-center gap-[6px]">
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <div
              key={i}
              className={
                i === step
                  ? "h-2 w-2 bg-accent"
                  : i < step
                    ? "h-2 w-2 bg-accent-lo"
                    : "h-2 w-2 border border-edge"
              }
            />
          ))}
        </div>

        <div className="flex flex-1 justify-end gap-2">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="border border-edge bg-transparent px-4 py-2 text-[12px] font-semibold text-text2 hover:border-edge2 hover:text-text"
            >
              {t("common.action.back")}
            </button>
          )}
          <button
            onClick={next}
            className="bg-accent px-5 py-2 text-[12px] font-bold text-sel-ink hover:bg-accent-hi"
          >
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
