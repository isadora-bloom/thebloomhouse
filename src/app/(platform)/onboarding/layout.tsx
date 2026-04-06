/**
 * Onboarding gets a clean full-screen layout — no sidebar, no shell chrome.
 * The PlatformShell detects /onboarding and skips the sidebar automatically.
 */
export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
