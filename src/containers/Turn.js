import React from 'react';
import Reflux from 'reflux';
import history from '../history';

import PlayersStore from '../stores/PlayersStore';
import PlayersActions from '../actions/PlayersActions';

import TitleBar from '../components/TitleBar';
import ListItems from '../components/ListItems';
import ListItem from '../components/ListItem';
import BottomDrawer from '../components/BottomDrawer';
import Rolls from '../components/Rolls';



const Turn = React.createClass({
    titleCase(str) {
        return str.replace(/\w\S*/g, function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();});
    },

    mixins: [Reflux.connectFilter(PlayersStore, 'player', function(players) {
        return players.filter(function(player) {
           return this.props.params.player === `${player.first_name.toLowerCase()}-${player.last_name.toLowerCase()}`;
        }.bind(this))[0];
    })],

    getInitialState() {
        return {
            turnActive: false,
        };
    },
    getTotal() {
        let total = 0;
        this.state.player.turns.map((points) => {
            total = total + Number(points);
        });
        return total;
    },
    nextTurn(e) {

        this.setState({ turnActive: true });

        e.preventDefault();
    },
    cancelTurn(e) {

        this.setState({ turnActive: false });
        e.preventDefault();
    },
    addToTotal(total) {

        let ask = confirm('Are you sure?');

        if(ask) {

            PlayersActions.playTurn(this.state.player.first_name, this.state.player.last_name, total);
            this.setState({ turnActive: false });
            history.pushState(null, '/game');

        }

    },
    renderTurns() {

        let turns = this.state.player.turns.map((points, index) => {

            return (
                <div className='turn' key={index}>
                    <label className='turn__label'>{`${points} points`}</label>
                    <div className="turn__actions">
                        {/* <a className='turn__edit'><span>Edit</span></a> */}
                    </div>
                </div>
            );
        });

        return turns;

    },
    renderAction() {
        if(!this.state.turnActive) {
            return (
                <a className="button" onClick={this.nextTurn}>Next Turn</a>
            );
        }

        return (
            <a className="button" onClick={this.cancelTurn}>Cancel</a>
        );
    },
    renderNewTurn() {

        if(this.state.turnActive) {
            return (
                <div className="turn-new">
                    <Rolls addToTotal={this.addToTotal} />
                </div>
            );
        }

        return null;
    },
    renderTotal() {

        return (
            <div className="turn-details">
                <div className="turn-details__total">
                    <h2>Total</h2>
                    <h3>{this.getTotal()}</h3>
                </div>
                {this.renderAction()}
            </div>
        );

    },
    render(){

        const name = this.props.params.player.split('-');
        const first_name = name[0];
        const last_name = name[1];

        return (
            <div>
                <TitleBar title={`${this.titleCase(first_name)} ${this.titleCase(last_name)}`} back={"/game/"} />
                {this.renderTurns()}

                <BottomDrawer>
                    {this.renderNewTurn()}
                    {this.renderTotal()}
                </BottomDrawer>
            </div>
        )
    }
});

export default Turn;
