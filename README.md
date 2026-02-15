VERY BAREBONES (CAN CONNECT AND CHAT)

Uses Bedrock-protocol, and microsoft oauth to connect to any server you like (in the index.js it is set to donutsmp, feel free to change it tho :D)

you can host it for free using koyeb (i think its like 7 days free trial).
If you are hosting with koyeb, set the build commands to be "npm install bedrock-protocol" and the start command or whatever its called to "node index.js"

also tries to use donut api to get the total amount of shards from all accounts combined.

If you are trying to AFK shards on the donutsmp, create a microsoft account, then join donutsmp.net on bedrock, and /sell all the starter gear.
They client does not yet have a /afk feature, and since you cant /afk random to teleport to a random world, it currently just waits until donutsmp automatically places it in the afk areas.

You could try to do "/afk 7" for example for area 7, but currently alot of people are afking so the command will almost always give you a "Area is filled" error.


Features:

Automatically joins Donutsmp.net
There is a chat feature, but i need to fix it from constantly closing on itself.
Total amount of shards from all accounts combined (need to add a button that refreshes it, currently it only refreshes every time the node index.js is run)


Features that im working on:
Proxy support
Get total shard amount button
random /afk
Gui Interactions (hard because of geysermc)
