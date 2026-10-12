import { asc } from "drizzle-orm";
import { AlertCircle, CheckCircle2, Cloud, MonitorPlay } from "lucide-react";
import { Suspense } from "react";
import { ActionButton } from "@/components/action-button";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getDb } from "@/server/db/client";
import { accounts, type Account, type Provider } from "@/server/db/schema";
import { isProviderConfigured, redirectUri } from "@/server/providers/oauth";
import { requireAdmin } from "@/server/session";
import { disconnectAccount } from "./actions";

export default function AccountsPage(props: PageProps<"/accounts">) {
  return (
    <>
      <PageHeader
        title="Cuentas"
        description="Vincula las cuentas de OneDrive de donde se toman los videos y los canales de YouTube a donde se suben."
      />
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <AccountsContent searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

const PROVIDER_INFO: Record<Provider, { title: string; description: string; icon: typeof Cloud; connectLabel: string }> = {
  microsoft: {
    title: "OneDrive",
    description: "Cuentas personales o de trabajo de Microsoft.",
    icon: Cloud,
    connectLabel: "Conectar OneDrive",
  },
  google: {
    title: "YouTube",
    description: "Cada canal se vincula por separado; al conectar, elige el canal en la pantalla de Google.",
    icon: MonitorPlay,
    connectLabel: "Conectar canal de YouTube",
  },
};

async function AccountsContent({ searchParams }: { searchParams: PageProps<"/accounts">["searchParams"] }) {
  await requireAdmin();
  const params = await searchParams;
  const all = getDb().select().from(accounts).orderBy(asc(accounts.displayName)).all();

  return (
    <div className="space-y-6">
      {typeof params.connected === "string" && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Cuenta vinculada</AlertTitle>
          <AlertDescription>
            La cuenta de {PROVIDER_INFO[params.connected as Provider]?.title ?? params.connected} quedó conectada.
          </AlertDescription>
        </Alert>
      )}
      {typeof params.error === "string" && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>No se pudo vincular la cuenta</AlertTitle>
          <AlertDescription>{params.error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        {(["microsoft", "google"] as const).map((provider) => (
          <ProviderCard key={provider} provider={provider} accounts={all.filter((a) => a.provider === provider)} />
        ))}
      </div>
    </div>
  );
}

function ProviderCard({ provider, accounts }: { provider: Provider; accounts: Account[] }) {
  const info = PROVIDER_INFO[provider];
  const configured = isProviderConfigured(provider);
  const Icon = info.icon;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-5" /> {info.title}
        </CardTitle>
        <CardDescription>{info.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configured ? (
          <Alert>
            <AlertCircle />
            <AlertTitle>Falta configurar OAuth</AlertTitle>
            <AlertDescription>
              <p>
                Define {provider === "microsoft" ? "MS_CLIENT_ID y MS_CLIENT_SECRET" : "GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET"}{" "}
                en <code>.env</code> y registra este redirect URI:
              </p>
              <code className="break-all">{redirectUri(provider)}</code>
            </AlertDescription>
          </Alert>
        ) : (
          <Button asChild>
            {/* Plain link: the route handler redirects to the provider. */}
            <a href={`/api/auth/${provider}/start`}>{info.connectLabel}</a>
          </Button>
        )}

        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay cuentas vinculadas.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-3 p-3">
                {account.avatarUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- remote avatar, no need for next/image
                  <img src={account.avatarUrl} alt="" className="size-8 rounded-full" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{account.displayName}</div>
                  {account.email && <div className="truncate text-sm text-muted-foreground">{account.email}</div>}
                  {account.status === "needs_reauth" && account.lastError && (
                    <div className="text-sm text-destructive">{account.lastError}</div>
                  )}
                </div>
                {account.status === "active" ? (
                  <Badge variant="secondary">Activa</Badge>
                ) : (
                  <Badge variant="destructive">Requiere reconexión</Badge>
                )}
                {account.status === "needs_reauth" && configured && (
                  <Button asChild size="sm" variant="outline">
                    <a href={`/api/auth/${provider}/start`}>Reconectar</a>
                  </Button>
                )}
                <ActionButton
                  size="sm"
                  variant="ghost"
                  action={disconnectAccount.bind(null, account.id)}
                  confirm={{
                    title: `¿Desconectar "${account.displayName}"?`,
                    description:
                      "Se borran los tokens guardados. Para revocar el acceso por completo, quítalo también desde la configuración de tu cuenta de Microsoft o Google.",
                    confirmLabel: "Desconectar",
                  }}
                >
                  Desconectar
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
