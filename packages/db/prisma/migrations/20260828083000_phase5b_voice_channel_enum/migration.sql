-- PostgreSQL requires a newly added enum value to commit before it is referenced.
ALTER TYPE "CommunicationChannel" ADD VALUE IF NOT EXISTS 'VOICE';
