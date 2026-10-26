-- 0005 Least-privilege grants for the runtime role `hotel_app`
-- (created by the migration runner before migrations run). The API never
-- connects as the owner, so row-level security always applies (SEC-03, SEC-06).

GRANT USAGE ON SCHEMA public TO hotel_app;

GRANT SELECT ON legal_entity, document_types, roles TO hotel_app;
GRANT SELECT, UPDATE ON properties TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON outlets TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON users TO hotel_app;
GRANT SELECT, INSERT, DELETE ON user_roles, user_property_access TO hotel_app;
GRANT SELECT, UPDATE ON number_sequences TO hotel_app;
GRANT SELECT, INSERT ON number_allocations TO hotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO hotel_app;
GRANT SELECT, INSERT ON audit_events TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON integration_outbox TO hotel_app;

GRANT EXECUTE ON FUNCTION next_document_number(uuid, text, uuid) TO hotel_app;
GRANT EXECUTE ON FUNCTION app_property_visible(uuid) TO hotel_app;
