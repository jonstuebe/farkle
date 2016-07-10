import Reflux from 'reflux';
import PlayersActions from '../actions/Players';

let defaultData = [
    {
        id: 1,
        name: 'Jon',
    },
    {
        id: 2,
        name: 'Kevin',
    },
    {
        id: 3,
        name: 'Josh',
    },
];

const PlayersStore = Reflux.createStore({

    listenables: PlayersActions,

    onAddPlayer() {
        console.log('add new player');
    },

    getInitialState() {
        return defaultData;
    },

});

export default PlayersStore;
