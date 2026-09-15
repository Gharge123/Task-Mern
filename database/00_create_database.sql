-- Task Sync Engine - PostgreSQL database creation
--
-- Run this file while connected to the default `postgres` database in pgAdmin 4.
-- If the `tasksync` database already exists, this script will fail harmlessly at
-- the CREATE DATABASE statement; in that case, simply continue with 01_schema.sql.
--
-- PostgreSQL does not allow CREATE DATABASE inside a transaction, so run this
-- statement separately in pgAdmin Query Tool if your client wraps statements.

CREATE DATABASE tasksync
    WITH
    OWNER = CURRENT_USER
    ENCODING = 'UTF8'
    TEMPLATE = template0;



