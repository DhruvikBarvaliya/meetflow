-- Runs once, on first initialisation of the Postgres data volume.
-- Creates the isolated database used by the integration/API test suite so
-- tests never touch development data.
CREATE DATABASE meetflow_test OWNER meetflow;
