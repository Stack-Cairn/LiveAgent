import GatewayApp from "@/app/GatewayApp";

export default function App() {
  // The view obtains image identity from the authenticated server endpoint.
  // No owner or selected backend is inferred from browser preferences.
  return <GatewayApp imageStudioIdentity={undefined} />;
}
