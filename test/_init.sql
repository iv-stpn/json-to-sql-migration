-- PostgreSQL initialization script for integration tests
-- This script runs when the postgres container starts up

-- Create a schema for our tests
CREATE SCHEMA IF NOT EXISTS migration_test;

-- Set default search path
ALTER DATABASE json_sql_parser_test SET search_path TO migration_test,public;

-- Grant permissions to test user
GRANT ALL ON SCHEMA migration_test TO testuser;
GRANT ALL ON ALL TABLES IN SCHEMA migration_test TO testuser;
GRANT ALL ON ALL SEQUENCES IN SCHEMA migration_test TO testuser;

-- Create a test function that can be used in default values
CREATE OR REPLACE FUNCTION migration_test.test_function() 
RETURNS TEXT AS $$
BEGIN
    RETURN 'test-value';
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission on the function
GRANT EXECUTE ON FUNCTION migration_test.test_function() TO testuser;
