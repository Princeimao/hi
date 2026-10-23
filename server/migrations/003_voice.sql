-- ElevenLabs joins the per-user integration services (TTS for voice replies).

ALTER TABLE integration_tokens DROP CONSTRAINT integration_tokens_service_check;
ALTER TABLE integration_tokens
  ADD CONSTRAINT integration_tokens_service_check
  CHECK (service IN ('github','vercel','notion','calcom','elevenlabs'));
