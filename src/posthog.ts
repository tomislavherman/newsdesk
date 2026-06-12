import { PostHog } from 'posthog-node';

const posthog = new PostHog(process.env.POSTHOG_API_KEY ?? 'none', {
  host: process.env.POSTHOG_HOST,
  enableExceptionAutocapture: true,
  disabled: !process.env.POSTHOG_API_KEY,
});

export default posthog;
