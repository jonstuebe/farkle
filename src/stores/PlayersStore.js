import Reflux from 'reflux';
import PlayersActions from '../actions/PlayersActions';
// import Immutable from 'immutable';
import _ from 'lodash';

let defaultData = [

];

let localStorageKey = 'players';

const PlayersStore = Reflux.createStore({

    listenables: PlayersActions,

    onAddPlayer(first_name, last_name) {

        let players = this.players;

        players.push({
            first_name,
            last_name,
            points: 0,
            turns: [],
        });

        this.updateStore(players);

    },

    onPlayTurn(first_name, last_name, total) { // total points for this turn

        let players = this.players;
        let playerIndex = _.findIndex(players, { first_name, last_name });
        let player = players[playerIndex];

        player.turns.push(parseInt(total));
        player.points = parseInt(player.points) + parseInt(total);

        this.updateStore(players);

    },

    updateStore(players) {
        localStorage.setItem(localStorageKey, JSON.stringify(players));
        this.trigger(players);
    },

    getInitialState() {

        var loadedPlayers = localStorage.getItem(localStorageKey);
        if(!loadedPlayers) {
            this.players = defaultData;
        } else {
            this.players = JSON.parse(loadedPlayers);
        }

        return this.players;
    },

});

export default PlayersStore;
