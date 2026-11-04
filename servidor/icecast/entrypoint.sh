#!/bin/sh
set -e
: "${ICECAST_MAX_LISTENERS:=500}"
: "${DOMAIN:=localhost}"
export ICECAST_MAX_LISTENERS DOMAIN
envsubst < /etc/icecast/icecast.xml.template > /etc/icecast/icecast.xml
exec icecast -c /etc/icecast/icecast.xml
