import React from 'react';
import { Link } from 'react-router';

import Reflux from 'reflux';
import Actions from '../actions/Actions';
// import PlayersStore from '../stores/PlayersStore';

import TitleBar from '../components/TitleBar';
import ListItems from '../components/ListItems';
import ListItem from '../components/ListItem';
import Message from '../components/Message';
import BottomDrawer from '../components/BottomDrawer';
import Button from '../components/Button';

const Players = React.createClass({

    mixins: [
        // Reflux.connect(PlayersStore, 'players'),
    ],

    getInitialState() {
        return {
            players: [],
        }
    },

    componentWillMount() {


    },

    addNewPlayer(e) {

        let first_name = this.refs.first_name.value,
            last_name = this.refs.last_name.value;

        let players = this.state.players;

        players.push({
            first_name,
            last_name,
            points: 0,
        });

        this.setState({ players });

        this.refs.first_name.value = '';
        this.refs.last_name.value = '';
        this.refs.last_name.blur();

        e.preventDefault();
    },

    getName(player) {
        return `${player.first_name} ${player.last_name}`;
    },

    renderNoPlayers() {
        return (
            <Message>
                <h2>No players exist in this game!</h2>
                <p>Add them below</p>
            </Message>
        )
    },

    renderPlayers() {

        if(this.state.players.length == 0) {
            return this.renderNoPlayers();
        }

        let players = this.state.players.map((player, index) => {
            return (
                <ListItem title={this.getName(player)} details='' key={index}  />
            );
        });

        return (
            <ListItems>
                {players}
            </ListItems>
        )

    },

    renderFields() {

        let style = {
            display: 'inline-block',
            width: '50%',
            boxSizing: 'border-box',
            borderRight: '1px solid #ccc',
        };

        return (
            <form onSubmit={this.addNewPlayer}>
                <input type="text" className="input input--name" placeholder="first name" style={style} ref='first_name' />
                <input type="text" className="input input--name" placeholder="last name" style={style} ref='last_name' />
                <input type="submit" className="button" value="Add New Player" style={{ width: '100%' }} />
            </form>
        );

        return null;

    },

    renderNext() {

        if(this.state.players.length > 1) {
            return (
                <Button to='/game' light={false} secondary={true}>Start Game</Button>
            );
        }

        return null;

    },

    render(){
        return (
            <div>
                <TitleBar title="Players" back={false} />
                {this.renderPlayers()}

                <BottomDrawer>
                    {this.renderFields()}
                    {this.renderNext()}
                </BottomDrawer>
            </div>
        )
    },

});

export default Players;
