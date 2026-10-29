// Every Git process a test starts inherits this, so no user or system config reaches it. A global
// `commit.gpgsign` would otherwise make a test's own commit wait on gpg and time out.
process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
