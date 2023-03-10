#/bin/bash

if [ -z "$(git status --porcelain)" ] ; then
	# clean
	echo clean
else
	# not clean
	echo not clean
	exit 1
fi

# capture the git log to a file
git log -n1 > ./git-head.txt

# now build it
docker-compose build
